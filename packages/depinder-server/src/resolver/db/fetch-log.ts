import type {Queryable} from './db.js'
import type {FetchRecord} from '../registries/http.js'
import {chunk} from '../worker/loop.js'

/**
 * Provenance (A9): every upstream request the worker made, with its status and timing. Feed
 * requests belong to no single package and are stored with a null `package_key`.
 */
export async function insertFetchLog(
    db: Queryable,
    packageKey: string | null,
    records: readonly FetchRecord[],
): Promise<void> {
    if (records.length === 0) return
    for (const batch of chunk(records, 100)) {
        const values: unknown[] = []
        const tuples = batch.map((record, i) => {
            const base = i * 7
            values.push(
                packageKey,
                record.source,
                record.url,
                record.status,
                record.startedAt,
                record.finishedAt,
                record.error,
            )
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
        })
        await db.query(
            `insert into fetch_log (package_key, source, url, http_status, started_at, finished_at, error)
             values ${tuples.join(', ')}`,
            values,
        )
    }
}

/** Rows one retention statement deletes at most, so no single delete holds the table for long. */
const PRUNE_BATCH = 10_000

/**
 * Retention: deletes `fetch_log` rows that started more than `retentionDays` ago, a batch at a
 * time until none are left. Returns how many went.
 */
export async function pruneFetchLog(db: Queryable, retentionDays: number): Promise<number> {
    let deleted = 0
    let batch: number
    do {
        const [row] = await db.query<{n: number}>(
            `with gone as (
                 delete from fetch_log
                 where id in (select id from fetch_log
                              where started_at < now() - make_interval(days => $1::int)
                              limit $2::int)
                 returning 1)
             select count(*)::int as n from gone`,
            [retentionDays, PRUNE_BATCH],
        )
        batch = row?.n ?? 0
        deleted += batch
    } while (batch === PRUNE_BATCH)
    return deleted
}
