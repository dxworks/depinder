import type {Config} from '../../config.js'
import type {Db, Queryable} from '../../db/db.js'
import type {ResolverEvents} from '../../events.js'
import type {FetchRecord} from '../../registries/http.js'
import {computeLatest} from '../../registries/latest.js'
import {type Logger, type ParsedPurl, versionPurl} from '@depinder/core'
import {CHANNEL_SETTLED} from '../../db/notify.js'
import type {FetchQueueRow} from '../../db/rows.js'
import type {FetchedPackage, FetchedVersion} from '../../registries/types.js'
import {insertFetchLog} from '../../db/fetch-log.js'
import {chunk} from '../loop.js'

/**
 * The demand-fill worker's write side: a fetched package lands in `package` / `package_version`
 * here, and its queue row goes with it.
 *
 * The write side is counted in round trips rather than in rows, because the database is hosted and
 * a statement costs a network hop whether it carries one row or five thousand. A resolved package
 * is five of them — `begin`, the package upsert (which takes the queue row with it), one statement
 * carrying every version it has, the `fetch_log` insert, `commit` — and a `not_found` is four. The
 * pool in `pool.ts` is only as wide as the pool of database clients underneath it: see
 * `DATABASE_POOL_SIZE`.
 */

/**
 * Version rows per statement. They travel as arrays through `unnest`, so the parameter count is
 * ten however many rows go with them and the pg parameter limit stops being the thing that decides
 * this: what is left is how large an array to hand one statement. At 5 000 every package we have
 * met is a single round trip — the busiest npm packages run to a few thousand versions — and the
 * ones that are not cost one more statement each.
 */
export const VERSION_CHUNK = 5_000
const NOT_FOUND_RETRY = "interval '24 hours'"

export interface JobContext {
    db: Db
    log: Logger
    config: Config
    events?: ResolverEvents
}

/**
 * A success, including the "upstream says this package does not exist" kind.
 *
 * The queue row is not deleted here: both package writes carry the delete as the tail of their own
 * statement, because a statement of its own would be another round trip. See {@link settleQueueRow}.
 *
 * `fetched_at` and `as_of` are both the time the fetch started, in every ecosystem: this is a full
 * fetch from the registry of record, and it is the only thing that vouches for these facts yet. A
 * feed cursor that has moved on since, or a later 304 on a poll, can vouch for more — the first is
 * worked out when a request reads the row, the second is written by the poll loop in `feeds.ts`.
 */
// [8] The only place package / package_version are written: one transaction, five round trips, queue row dropped with it.
export async function writeResult(
    job: JobContext,
    row: FetchQueueRow,
    key: ParsedPurl,
    fetched: FetchedPackage | null,
    records: readonly FetchRecord[],
    fetchedAt: Date,
): Promise<void> {
    await job.db.withTransaction(async tx => {
        if (!fetched) {
            await markNotFound(tx, key, fetchedAt, row.requests)
        } else {
            const latest = computeLatest(key.type, fetched.versions, fetched.registryLatest)
            const source = fetched.sources.join(', ')
            await upsertResolved(tx, key, fetched, latest, source, fetchedAt, row.requests)
            await replaceVersions(tx, key, fetched, source, fetchedAt)
        }
        await insertFetchLog(tx, key.packageKey, records)
    })

    // After the commit, never inside it: a request hearing this reads the row immediately, and a
    // row in an open transaction is not there yet. `not_found` counts — it is terminal too.
    job.events?.settled(key.packageKey)
}

/**
 * The tail every package write ends in: the queue row goes, unless somebody asked for the package
 * again after it was dequeued — a feed event, a poll, a request — in which case it stays and is
 * made due at once, because this fetch may have been too early to see what they were told about.
 * `enqueue` counts every ask in `requests`, so "again" is the count having moved. The two halves
 * are disjoint, so they can share a statement.
 *
 * `$1` is the package key; `requests` names the parameter holding the count that was dequeued.
 */
export function settleQueueRow(requests: string): string {
    return `done as (delete from fetch_queue
                     where package_key = $1
                       and requests = ${requests}::int)
         update fetch_queue
         set next_attempt_at = now(),
             attempts        = 0,
             leased          = false
         where package_key = $1
           and requests <> ${requests}::int`
}

/**
 * The `returning` of every terminal package write: tells a `/resolve` in another process, on
 * commit, that this package has an answer. In-process listeners hear it from `events.settled`. A
 * data-modifying CTE runs to completion — `returning` included — whether or not anything reads it,
 * so this costs the write no extra statement.
 */
export const notifySettled = `pg_notify('${CHANNEL_SETTLED}', package_key)`

/** The package row, and with it the queue row that asked for it. */
async function markNotFound(tx: Queryable, key: ParsedPurl, fetchedAt: Date, requests: number): Promise<void> {
    await tx.query(
        `with saved as (
             insert into package (package_key, type, namespace, name, status, error, fetched_at, as_of, next_retry_at)
                 values ($1, $2, $3, $4, 'not_found', null, $5, $5, $5::timestamptz + ${NOT_FOUND_RETRY})
                 on conflict (package_key) do update
                     set status        = 'not_found',
                         error         = null,
                         fetched_at    = excluded.fetched_at,
                         as_of         = excluded.as_of,
                         next_retry_at = excluded.next_retry_at
                 returning ${notifySettled}),
         ${settleQueueRow('$6')}`,
        [key.packageKey, key.type, key.namespace, key.name, fetchedAt, requests],
    )
}

/** The package row, and with it the queue row that asked for it. */
async function upsertResolved(
    tx: Queryable,
    key: ParsedPurl,
    fetched: FetchedPackage,
    latest: {latest?: string; latestPrerelease?: string},
    source: string,
    fetchedAt: Date,
    requests: number,
): Promise<void> {
    await tx.query(
        `with saved as (
             insert into package (package_key, type, namespace, name, description, homepage_url, repo_url, licenses,
                                  latest_version, latest_prerelease_version, status, error, source, fetched_at, as_of,
                                  next_retry_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, 'resolved', null, $11, $12, $12, $14)
                 on conflict (package_key) do update
                     set description               = excluded.description,
                         homepage_url              = excluded.homepage_url,
                         repo_url                  = excluded.repo_url,
                         licenses                  = excluded.licenses,
                         latest_version            = excluded.latest_version,
                         latest_prerelease_version = excluded.latest_prerelease_version,
                         status                    = 'resolved',
                         error                     = null,
                         source                    = excluded.source,
                         fetched_at                = excluded.fetched_at,
                         as_of                     = excluded.as_of,
                         -- A registry that knows its facts are incomplete asks to be fetched again.
                         next_retry_at             = excluded.next_retry_at
                 returning ${notifySettled}),
         ${settleQueueRow('$13')}`,
        [
            key.packageKey,
            key.type,
            key.namespace,
            key.name,
            fetched.description ?? null,
            fetched.homepageUrl ?? null,
            fetched.repoUrl ?? null,
            fetched.licenses,
            latest.latest ?? null,
            latest.latestPrerelease ?? null,
            source,
            fetchedAt,
            requests,
            fetched.recheckAt ?? null,
        ],
    )
}

/**
 * The registry is the whole truth about a package, so its version list replaces ours: a version
 * that disappeared upstream must disappear here too.
 *
 * That used to be a `delete` followed by an `insert`. It is now one statement: the rows travel as
 * arrays through `unnest` and are upserted, and a `delete` of everything the list does not mention
 * rides along as a CTE. The two halves cannot collide — the delete keeps exactly the purls the
 * insert is bringing — and a package costs one round trip instead of two, with none of the window
 * in which the package briefly had no versions at all.
 */
async function replaceVersions(
    tx: Queryable,
    key: ParsedPurl,
    fetched: FetchedPackage,
    source: string,
    fetchedAt: Date,
): Promise<void> {
    const rows = versionRows(key, fetched)
    const parts = chunk(rows, VERSION_CHUNK)
    if (parts.length === 0) {
        // A registry that now lists no versions at all: nothing to upsert, so the delete goes alone.
        await tx.query('delete from package_version where package_key = $1', [key.packageKey])
        return
    }

    for (const [i, part] of parts.entries()) {
        const params: unknown[] = [
            key.packageKey,
            part.map(r => r.purl),
            part.map(r => r.version),
            part.map(r => r.releasedAt),
            // `licenses` travels as one JSON array per row: a text[][] would have to be rectangular,
            // and these are ragged. `array(select ...)` turns each element back into the text[] the
            // column holds.
            part.map(r => JSON.stringify(r.licenses)),
            part.map(r => r.prerelease),
            part.map(r => r.yanked),
            source,
            fetchedAt,
        ]
        // The stale delete goes on the first statement only, and it is told the whole version list
        // rather than this chunk, so that a package split across chunks cannot delete the rows the
        // next statement is about to write.
        if (i === 0) params.push(rows.map(r => r.purl))
        await tx.query(versionsSql(i === 0), params)
    }
}

/** A version with the purl it is stored under. */
interface VersionRow extends FetchedVersion {
    purl: string
}

/**
 * The rows for one package, deduplicated by purl. A registry can list the same version twice, and
 * `on conflict do update` refuses to touch a row twice in one statement; the delete-then-insert
 * this replaced let the second one fall through `do nothing`, so the first still wins.
 */
function versionRows(key: ParsedPurl, fetched: FetchedPackage): VersionRow[] {
    const rows: VersionRow[] = []
    const seen = new Set<string>()
    for (const version of fetched.versions) {
        const purl = versionPurl(key.packageKey, version.version)
        if (seen.has(purl)) continue
        seen.add(purl)
        rows.push({...version, purl})
    }
    return rows
}

/** {@link replaceVersions}'s statement, with the stale delete on the front for the first chunk. */
function versionsSql(withStale: boolean): string {
    const stale = withStale
        ? `,
                 stale as (delete from package_version
                           where package_key = $1
                             and purl not in (select unnest($10::text[])))`
        : ''
    return `with incoming as (select *
                              from unnest($2::text[], $3::text[], $4::timestamptz[], $5::jsonb[],
                                          $6::boolean[], $7::boolean[])
                                       as t(purl, version, released_at, licenses, prerelease, yanked))${stale}
            insert into package_version (purl, package_key, version, released_at, licenses, prerelease, yanked,
                                         source, fetched_at)
            select i.purl,
                   $1::text,
                   i.version,
                   i.released_at,
                   array(select jsonb_array_elements_text(i.licenses)),
                   i.prerelease,
                   i.yanked,
                   $8::text,
                   $9::timestamptz
            from incoming i
            on conflict (purl) do update
                set released_at = excluded.released_at,
                    licenses    = excluded.licenses,
                    prerelease  = excluded.prerelease,
                    yanked      = excluded.yanked,
                    source      = excluded.source,
                    fetched_at  = excluded.fetched_at`
}
