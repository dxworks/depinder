import type {Config} from '../config.js'
import type {Db} from '../db/db.js'
import {createRegistryClient, type FetchRecord} from '../registries/http.js'
import {errorMessage, type Logger, parsePurl} from '@depinder/core'
import {enqueue, PRIORITY} from '../db/queue.js'
import {registries} from '../registries/index.js'
import type {FeedSpec, FetchContext, Registry} from '../registries/types.js'
import {insertFetchLog} from '../db/fetch-log.js'
import {startLoop, type Loop} from './loop.js'

/**
 * Keeping stored packages fresh (A5, A6). One loop per implemented ecosystem, in one of two modes:
 *
 *  - `feed`: the registry publishes a change stream with a cursor. We read from the stored cursor,
 *    keep the events that name a package we track, queue those, and advance the cursor.
 *  - `poll`: the registry has no feed (maven, cargo). We walk our own tracked packages and make a
 *    conditional GET per package; a 200 means something changed and the package is re-queued, and
 *    a 304 vouches for the package, moving its `as_of` up to the time of the check. The first
 *    sweep runs a minute after boot rather than a whole interval later — see `POLL_FIRST_SWEEP_MS`.
 *
 * The distinction is visible on `/feeds`, and it is what can vouch for a package after its last
 * fetch: the feed's live cursor for the first (worked out when a request reads the row, never
 * stored per package), a 304 written into `as_of` for the second. See "Freshness" in
 * docs/resolver-api.md.
 */

const PAGE_SIZE = 200

/**
 * How long a poll-mode loop waits before its first sweep.
 *
 * Its interval is six hours, and lag in poll mode is measured from the last successful sweep — so
 * waiting a whole interval for the first one would leave `/feeds` reporting `lag_seconds: null`
 * for six hours after every boot, with nothing to say whether polling works at all. A minute is
 * long enough to keep boot cheap and let demand-fill have the first moments, and short enough
 * that the first real sweep is part of starting up.
 */
export const POLL_FIRST_SWEEP_MS = 60_000

/**
 * When a registry's loop makes its first run. Poll mode sweeps a minute after boot; feed mode can
 * wait one interval (30–120 s), because its lag comes from the cursor rather than from our clock
 * and a missed tick costs nothing — the cursor picks up where it stopped.
 */
export function firstRunDelayMs(feed: FeedSpec): number {
    return feed.mode === 'poll' ? Math.min(POLL_FIRST_SWEEP_MS, feed.intervalMs) : feed.intervalMs
}

interface FeedWorkerOptions {
    db: Db
    log: Logger
    config: Config
}

export function startFeeds(options: FeedWorkerOptions): Loop {
    const log = options.log.child({component: 'feeds'})
    const loops: Loop[] = []

    for (const registry of Object.values(registries)) {
        const registryLog = log.child({registry: registry.type})
        loops.push(
            startLoop({
                name: `feed:${registry.type}`,
                intervalMs: registry.feed.intervalMs,
                log: registryLog,
                run: () => runFeedOnce(registry, {...options, log: registryLog}),
                initialDelayMs: firstRunDelayMs(registry.feed),
            }),
        )
    }

    log.info('feed loops started', {registries: Object.keys(registries)})
    return {
        async stop() {
            await Promise.all(loops.map(l => l.stop()))
        },
    }
}

/** Ensures a `registry_feed` row exists for every implemented ecosystem. Called once at boot. */
export async function ensureFeedRows(db: Db): Promise<void> {
    for (const registry of Object.values(registries)) {
        await db.query(
            `insert into registry_feed (type, mode)
             values ($1, $2)
             on conflict (type) do update set mode = excluded.mode`,
            [registry.type, registry.feed.mode],
        )
    }
}

export async function runFeedOnce(registry: Registry, options: FeedWorkerOptions): Promise<void> {
    const records: FetchRecord[] = []
    const ctx: FetchContext = {
        http: createRegistryClient({type: registry.type, recorder: record => records.push(record)}),
        log: options.log,
        options: {mavenPerVersionLicenses: options.config.mavenPerVersionLicenses},
    }

    try {
        if (registry.feed.mode === 'feed') await runCursorFeed(registry, options, ctx, records)
        else await runPollFeed(registry, options, ctx)
        await options.db.query(
            `update registry_feed set last_run_at = now(), last_ok_at = now(), last_error = null where type = $1`,
            [registry.type],
        )
    } catch (e) {
        const message = errorMessage(e)
        options.log.warn('feed tick failed', {error: message})
        await options.db
            .query('update registry_feed set last_run_at = now(), last_error = $2 where type = $1', [
                registry.type,
                message,
            ])
            .catch(() => undefined)
    } finally {
        if (records.length > 0) {
            await insertFetchLog(options.db, null, records).catch(() => undefined)
        }
    }
}

async function runCursorFeed(
    registry: Registry,
    options: FeedWorkerOptions,
    ctx: FetchContext,
    records: FetchRecord[],
): Promise<void> {
    const spec = registry.feed
    if (spec.mode !== 'feed') return
    const {db, log} = options

    const row = await db.one<{cursor: string | null}>('select cursor from registry_feed where type = $1', [
        registry.type,
    ])

    if (!row?.cursor) {
        // Nothing stored: start at the head, not at the beginning of time. What the feed covers
        // starts here too — a package fetched before now may have changed in a stretch the feed
        // never saw, so only packages fetched after `covered_since` count as covered by it.
        const cursor = await spec.initialCursor(ctx)
        await db.query(
            `update registry_feed
             set cursor        = $2,
                 cursor_time   = now(),
                 covered_since = now(),
                 last_run_at   = now()
             where type = $1`,
            [registry.type, cursor],
        )
        log.info('feed cursor initialised', {cursor})
        return
    }

    const result = await spec.poll(row.cursor, ctx)
    const keys = [...new Set(result.events.map(e => e.packageKey))]
    const tracked = await trackedPackages(db, keys)

    await db.withTransaction(async tx => {
        await enqueue(tx, tracked, PRIORITY.feed)
        await tx.query(
            `update registry_feed
             set cursor             = $2,
                 cursor_time        = coalesce($3::timestamptz, $4::timestamptz, cursor_time),
                 upstream_head_time = coalesce($4::timestamptz, upstream_head_time),
                 last_run_at        = now()
             where type = $1`,
            [registry.type, result.cursor, result.cursorTime, result.headTime],
        )
        await insertFetchLog(tx, null, records)
    })
    records.length = 0 // already written inside the transaction

    if (tracked.length > 0 || result.events.length > 0) {
        log.info('feed batch', {events: result.events.length, queued: tracked.length, cursor: result.cursor})
    }
}

/** The one query the plan calls for: which of these changed packages do we actually hold? */
async function trackedPackages(db: Db, packageKeys: string[]): Promise<string[]> {
    if (packageKeys.length === 0) return []
    const rows = await db.query<{package_key: string}>(
        'select package_key from package where package_key = any($1::text[]) and tracked',
        [packageKeys],
    )
    return rows.map(r => r.package_key)
}

async function runPollFeed(registry: Registry, options: FeedWorkerOptions, ctx: FetchContext): Promise<void> {
    const spec = registry.feed
    if (spec.mode !== 'poll') return
    const {db, log} = options

    let after = ''
    let scanned = 0
    let changed = 0
    let confirmed = 0
    let failed = 0

    for (;;) {
        const page = await db.query<{
            package_key: string
            poll_etag: string | null
            poll_last_modified: string | null
            fetched_at: Date | null
        }>(
            `select package_key, poll_etag, poll_last_modified, fetched_at
             from package
             where type = $1
               and tracked
               and package_key > $2
             order by package_key
             limit $3`,
            [registry.type, after, PAGE_SIZE],
        )
        if (page.length === 0) break
        after = page[page.length - 1]!.package_key
        scanned += page.length

        const due: string[] = []
        const vouched: {key: string; at: Date}[] = []
        await Promise.all(
            page.map(async row => {
                // A per-package recorder: only interesting checks reach fetch_log. A 6-hourly
                // sweep over every tracked maven artifact is mostly 304s, and logging each one
                // would bury the provenance that matters under its own noise.
                const records: FetchRecord[] = []
                const perPackage: FetchContext = {
                    ...ctx,
                    http: createRegistryClient({type: registry.type, recorder: r => records.push(r)}),
                }
                try {
                    const key = parsePurl(row.package_key)
                    // Stamped before the request: a 304 vouches for the package as of when we
                    // asked, not as of when the answer happened to arrive.
                    const checkedAt = new Date()
                    const result = await spec.check(
                        {
                            packageKey: row.package_key,
                            key,
                            etag: row.poll_etag,
                            lastModified: row.poll_last_modified,
                            fetchedAt: row.fetched_at,
                        },
                        perPackage,
                    )
                    await storeValidators(db, row.package_key, result)
                    if (result.confirmed) vouched.push({key: row.package_key, at: checkedAt})
                    if (result.changed) {
                        due.push(row.package_key)
                        await insertFetchLog(db, row.package_key, records)
                    }
                } catch (e) {
                    failed++
                    log.debug('poll check failed', {package: row.package_key, error: errorMessage(e)})
                    await insertFetchLog(db, row.package_key, records).catch(() => undefined)
                }
            }),
        )

        if (vouched.length > 0) {
            confirmed += vouched.length
            await confirmUnchanged(db, vouched)
        }
        if (due.length > 0) {
            changed += due.length
            await enqueue(db, due, PRIORITY.feed)
        }
        if (page.length < PAGE_SIZE) break
    }

    if (scanned > 0) log.info('poll sweep finished', {scanned, changed, confirmed, failed})
}

/**
 * One page's worth of 304s, in one statement: each package's `as_of` moves up to the moment its
 * check was sent. Never `fetched_at` — nothing was fetched, and the version cache in the api keys
 * on it. A row without a full fetch behind it is left alone whatever the check said.
 */
async function confirmUnchanged(db: Db, vouched: readonly {key: string; at: Date}[]): Promise<void> {
    await db.query(
        `update package p
         set as_of = greatest(p.as_of, v.at)
         from unnest($1::text[], $2::timestamptz[]) as v(package_key, at)
         where p.package_key = v.package_key
           and p.fetched_at is not null`,
        [vouched.map(v => v.key), vouched.map(v => v.at)],
    )
}

async function storeValidators(
    db: Db,
    packageKey: string,
    result: {etag?: string | null; lastModified?: string | null},
): Promise<void> {
    const setEtag = result.etag !== undefined
    const setLastModified = result.lastModified !== undefined
    if (!setEtag && !setLastModified) return
    await db.query(
        `update package
         set poll_etag          = case when $3 then $2 else poll_etag end,
             poll_last_modified = case when $5 then $4 else poll_last_modified end
         where package_key = $1`,
        [packageKey, result.etag ?? null, setEtag, result.lastModified ?? null, setLastModified],
    )
}
