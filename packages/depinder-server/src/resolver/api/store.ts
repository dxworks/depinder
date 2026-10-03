import {isDeadlock, type Db} from '../db/db.js'
import type {ResolverEvents} from '../events.js'
import {CHANNEL_QUEUED, CHANNEL_WANTED} from '../db/notify.js'
import type {ParsedPurl} from '../../shared/purl.js'
import {enqueue, PRIORITY, sortedUnique} from '../db/queue.js'
import type {PackageVersionsRow, QueueStats, RegistryFeedRow, ResolvePackageRow} from '../db/rows.js'

/**
 * Every database access `POST /resolve` makes, behind an interface so the handler can be tested
 * without a Postgres.
 */
export interface ResolveStore {
    /** The rows, each with its `confirmed_at` worked out and whether it is already queued. */
    getPackages(packageKeys: readonly string[]): Promise<ResolvePackageRow[]>
    /** One row per package, holding every version it has as {@link CompactVersion} tuples. */
    getVersions(packageKeys: readonly string[]): Promise<PackageVersionsRow[]>
    /**
     * Inserts unknown packages as `pending` and queues them at demand priority, wanted until
     * `wantedUntil`. One another request created a moment earlier is marked wanted instead.
     */
    createPending(purls: readonly ParsedPurl[], wantedUntil: Date | null): Promise<void>
    /**
     * Queues stale packages at refresh priority, wanted until `wantedUntil`. A package that already
     * has a queue row keeps its priority, its schedule and its `requests` count; only the later
     * deadline is kept.
     */
    queueRefresh(packageKeys: readonly string[], wantedUntil: Date | null): Promise<void>
    /**
     * Marks queued packages as wanted until `wantedUntil` — the ones this request waits for but did
     * not queue itself — and tells the worker holding any of them, so its fetch jumps the limiter.
     */
    markWanted(packageKeys: readonly string[], wantedUntil: Date): Promise<void>
    /** Every ecosystem's freshness. Memoised for {@link FEEDS_TTL_MS}. */
    getFeeds(): Promise<RegistryFeedRow[]>
    /** What `fetch_queue` holds, per ecosystem and priority, and how many packages gave up. */
    getQueue(): Promise<QueueStats>
}

/**
 * How long the feed rows are reused for.
 *
 * Eight rows, one round trip, ~50 ms — and every `/resolve` ends with it, however little of the
 * rest of the request touched the database. The feed loops advance their cursors every 30 s at the
 * quickest, and `lag_seconds` is a number of seconds, so five of them is invisible in the answer
 * and takes the query off all but one request in a burst. The same memo also collapses the six
 * chunks of a bulk run, which arrive together, into one query.
 */
export const FEEDS_TTL_MS = 5_000

/**
 * The compact version array, built by Postgres rather than by us.
 *
 * This is the single most expensive query the service makes, and what made it expensive was never
 * the execution — Postgres answers a 1 716-package chunk in ~114 ms — but the 25 MB of wide rows
 * that answer used to drag back over the internet from a hosted database at ~8 MB/s. So the row is
 * narrowed and folded here, where it costs nothing: `json_agg` returns one row per package instead
 * of 200 000 rows, the two booleans become one integer, the timestamp becomes an integer, and the
 * per-version license array is sent only when it differs from the package's own (`is distinct
 * from`, so an explicit `[]` against a package's `["MIT"]` still ships, as `[]`).
 *
 * `p.licenses` needs no `group by`: it is only ever read inside the aggregate.
 */
const VERSIONS_SQL = `select v.package_key,
                             json_agg(
                                     case
                                         when v.licenses is distinct from p.licenses
                                             then json_build_array(v.version,
                                                                   floor(extract(epoch from v.released_at))::bigint,
                                                                   (v.prerelease::int) | (v.yanked::int << 1),
                                                                   to_json(v.licenses))
                                         else json_build_array(v.version,
                                                               floor(extract(epoch from v.released_at))::bigint,
                                                               (v.prerelease::int) | (v.yanked::int << 1))
                                         end
                                     order by v.released_at asc nulls first, v.version asc) as versions
                      from package_version v
                               join package p on p.package_key = v.package_key
                      where v.package_key = any($1::text[])
                      group by v.package_key`

/**
 * The package rows, and how fresh each one is.
 *
 * `confirmed_at` is the freshness rule of docs/resolver-api.md, in one place. A full fetch, and for
 * maven and cargo a 304 since, is already in `as_of`. A feed ecosystem also vouches for a package
 * simply by moving on without naming it — but that is written nowhere per package, because it would
 * mean rewriting every tracked row every 30 s. So it is read here, as the feed's `cursor_time`, and
 * only when the feed can be believed about this package: it is tracked, the feed was already
 * running when it was fetched (`covered_since`), its last refresh did not fail, and no event about
 * it is still waiting in the queue. Otherwise the package is as fresh as `as_of` says, no fresher.
 *
 * The joins are `left` so that a package is never lost to a missing feed row or a missing queue
 * row: it comes back with `as_of` and `queued = false`.
 */
const PACKAGES_SQL = `select p.*,
                             case
                                 when f.mode = 'feed'
                                     and p.tracked
                                     and p.error is null
                                     and q.package_key is null
                                     and p.fetched_at is not null
                                     and f.covered_since is not null
                                     and p.fetched_at >= f.covered_since
                                     then greatest(p.as_of, f.cursor_time)
                                 else p.as_of
                                 end                    as confirmed_at,
                             (q.package_key is not null) as queued
                      from package p
                               left join registry_feed f on f.type = p.type
                               left join fetch_queue q on q.package_key = p.package_key
                      where p.package_key = any($1::text[])`

/**
 * Keeps the later of a row's deadline and `$2`, and tells whoever holds a row (`leased`) that it is
 * wanted now. `next_attempt_at` is not touched: a row in backoff stays in backoff. `$3` is `$2` in
 * epoch milliseconds, which is what the notification carries.
 */
const MARK_WANTED_SQL = `update fetch_queue
                         set wanted_until = greatest(wanted_until, $2::timestamptz)
                         where package_key = any($1::text[])
                         returning case when leased then pg_notify('${CHANNEL_WANTED}', package_key || ' ' || $3) end`

/** `events`, when the worker shares this process, is told about the work `createPending` queues. */
export function createResolveStore(db: Db, events?: ResolverEvents): ResolveStore {
    return {
        async getPackages(packageKeys) {
            if (packageKeys.length === 0) return []
            return db.query<ResolvePackageRow>(PACKAGES_SQL, [packageKeys])
        },

        async getVersions(packageKeys) {
            if (packageKeys.length === 0) return []
            return db.query<PackageVersionsRow>(VERSIONS_SQL, [packageKeys])
        },

        async createPending(purls, wantedUntil) {
            if (purls.length === 0) return
            const byKey = new Map(purls.map(p => [p.packageKey, p]))
            // Sorted by key, not in the order the purls arrived. `insert ... on conflict do
            // nothing` speculatively inserts each new row and holds it against other inserters
            // until the transaction ends, so two of these carrying the same package take its lock
            // in whatever order their own purl list happened to have. A depinder run posts four
            // chunks at once and they overlap, so against an empty database — where every key is a
            // new row, and so every key is a lock — chunk A took X then Y while chunk B took Y then
            // X, Postgres broke the cycle after `deadlock_timeout`, and the losing chunk came back
            // as an HTTP 500. One order for every caller is the fix; the retry below is the net.
            const unique = [...byKey.values()].sort((a, b) => compare(a.packageKey, b.packageKey))

            /** Keys another request created a moment earlier, and this one marked wanted. */
            let raced: string[] = []
            const insert = (): Promise<void> =>
                db.withTransaction(async tx => {
                    // Only what this insert created is queued. A package another chunk created a
                    // moment ago is queued by that chunk, and may already be mid-fetch: asking for
                    // it again would count as a second request and fetch it twice. See `enqueue`.
                    const created = await tx.query<{package_key: string}>(
                        `insert into package (package_key, type, namespace, name, status)
                         select t.package_key, t.type, t.namespace, t.name, 'pending'
                         from unnest($1::text[], $2::text[], $3::text[], $4::text[])
                                  as t(package_key, type, namespace, name)
                         on conflict (package_key) do nothing
                         returning package_key`,
                        [
                            unique.map(p => p.packageKey),
                            unique.map(p => p.type),
                            unique.map(p => p.namespace),
                            unique.map(p => p.name),
                        ],
                    )
                    await enqueue(tx, created.map(r => r.package_key), PRIORITY.demand, wantedUntil)
                    // Created a moment ago by another request, and queued by it with its own
                    // deadline: this caller waits too, perhaps longer.
                    if (wantedUntil && created.length < unique.length) {
                        const mine = new Set(created.map(r => r.package_key))
                        const others = unique.map(p => p.packageKey).filter(key => !mine.has(key))
                        await tx.query(MARK_WANTED_SQL, [others, wantedUntil, String(wantedUntil.getTime())])
                        raced = others
                    }
                })

            try {
                await insert()
            } catch (e) {
                // Sorting rules out a deadlock between two of these. It cannot rule out one against
                // every other writer of the same two tables — a feed enqueue, the worker dropping a
                // queue row — so a victim is still possible, and it is always worth exactly one
                // more go: the transaction rolled back whole and both its statements are upserts.
                if (!isDeadlock(e)) throw e
                await insert()
            }
            // After the commit: the pump goes to the queue the moment it hears this, and rows in
            // an open transaction are not there to be dequeued.
            events?.queued()
            if (wantedUntil) for (const key of raced) events?.wanted(key, wantedUntil.getTime())
        },

        async queueRefresh(packageKeys, wantedUntil) {
            // Sorted for the same reason `createPending` sorts: one lock order for every writer.
            const keys = sortedUnique(packageKeys)
            if (keys.length === 0) return
            // Not `enqueue`. Its conflict branch counts the ask, and a counted ask on a row that is
            // being fetched right now makes the worker fetch the package a second time. A queued
            // package already has the refresh this would ask for, so a conflict only keeps the
            // later deadline.
            const insert = (): Promise<unknown> =>
                db.query(
                    `with queued as (insert into fetch_queue (package_key, priority, requested_at, attempts,
                                                              next_attempt_at, wanted_until)
                                     select t.key, $2::int, now(), 0, now(), $3::timestamptz
                                     from unnest($1::text[]) as t(key)
                                     on conflict (package_key) do update
                                         set wanted_until = greatest(fetch_queue.wanted_until,
                                                                     excluded.wanted_until))
                     select pg_notify('${CHANNEL_QUEUED}', '')`,
                    [keys, PRIORITY.refresh, wantedUntil],
                )
            try {
                await insert()
            } catch (e) {
                // As in `createPending`: one statement, rolled back whole, safe to run once more.
                if (!isDeadlock(e)) throw e
                await insert()
            }
            events?.queued()
        },

        async markWanted(packageKeys, wantedUntil) {
            // Sorted for the same reason as everywhere else here: one lock order for every writer.
            const keys = sortedUnique(packageKeys)
            if (keys.length === 0) return
            const update = (): Promise<unknown> =>
                db.query(MARK_WANTED_SQL, [keys, wantedUntil, String(wantedUntil.getTime())])
            try {
                await update()
            } catch (e) {
                if (!isDeadlock(e)) throw e
                await update()
            }
            // After the commit, as ever. A worker in another process hears it from Postgres.
            for (const key of keys) events?.wanted(key, wantedUntil.getTime())
        },

        getFeeds: memoise(FEEDS_TTL_MS, async () =>
            db.query<RegistryFeedRow>(
                `select type,
                        mode,
                        cursor,
                        cursor_time,
                        last_run_at,
                        last_ok_at,
                        upstream_head_time,
                        last_error,
                        covered_since,
                        case
                            when mode = 'feed' then floor(extract(epoch from (now() - cursor_time)))::int
                            else floor(extract(epoch from (now() - last_ok_at)))::int
                            end as lag_seconds
                 from registry_feed
                 order by type`,
            ),
        ),

        async getQueue() {
            // One round trip: the groups travel as one json array next to the error count. Not
            // memoised — it is asked for by a person or a dashboard, not by every request.
            const row = await db.one<{groups: QueueStats['groups']; errors: number}>(
                `select coalesce((select json_agg(g order by g.type, g.priority)
                                  from (select type,
                                               priority,
                                               count(*)::int                                                 as queued,
                                               count(*) filter (where wanted_until > now())::int              as urgent,
                                               count(*) filter (where leased and next_attempt_at > now())::int as in_flight,
                                               count(*) filter (where next_attempt_at <= now())::int          as due,
                                               count(*) filter (where attempts > 0)::int                      as retrying,
                                               coalesce(extract(epoch from now() - min(requested_at)
                                                   filter (where next_attempt_at <= now())), 0)::int          as oldest_due_s
                                        from fetch_queue
                                        group by type, priority) g), '[]'::json) as groups,
                        (select count(*)::int from package where status = 'error')     as errors`,
            )
            return {groups: row?.groups ?? [], errors: row?.errors ?? 0}
        },
    }
}

/**
 * The order `Array.prototype.sort` puts strings in — UTF-16 code units — spelled out, so that
 * sorting by a key here and sorting the keys themselves in `enqueue` agree.
 */
function compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0
}

/**
 * `fn`, re-run at most every `ttlMs`. The promise is what is held, not its result, so calls that
 * arrive while one is in flight join it rather than starting another; a rejection is dropped, so
 * the next caller retries rather than being handed the same failure for five seconds.
 */
function memoise<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
    let cached: Promise<T> | undefined
    let readAt = 0
    return () => {
        if (!cached || Date.now() - readAt >= ttlMs) {
            readAt = Date.now()
            cached = fn().catch(e => {
                cached = undefined
                throw e
            })
        }
        return cached
    }
}
