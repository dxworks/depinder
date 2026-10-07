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
