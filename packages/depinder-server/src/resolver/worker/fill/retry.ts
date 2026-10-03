import type {Db} from '../../db/db.js'
import type {FetchRecord} from '../../registries/http.js'
import type {Logger} from '@depinder/core'
import {CHANNEL_QUEUED} from '../../db/notify.js'
import {PRIORITY} from '../../db/queue.js'
import type {FetchQueueRow} from '../../db/rows.js'
import {insertFetchLog} from '../../db/fetch-log.js'
import {notifySettled, settleQueueRow, type JobContext} from './write.js'

export const MAX_ATTEMPTS = 3
/** Backoff after the 1st, 2nd and 3rd failure. The queue gives up at MAX_ATTEMPTS. */
const BACKOFF_MS = [30_000, 120_000, 600_000]
const ERROR_RETRY = "interval '1 hour'"

/** A failed attempt: back off, or give up once the attempts are spent. */
// [9] Failure: BACKOFF_MS [30s, 2m, 10m], 3 attempts, then giveUp() stores 'error'. Next stop [10], in core's registries/types.ts.
export async function recordFailure(
    job: JobContext,
    row: FetchQueueRow,
    message: string,
    records: readonly FetchRecord[],
): Promise<void> {
    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
        await giveUp(job, row, message, records)
        return
    }
    const backoff = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!
    job.log.warn('fetch failed, will retry', {package: row.package_key, attempts, backoffMs: backoff, error: message})
    await job.db.withTransaction(async tx => {
        await tx.query(
            `update fetch_queue
             set attempts        = $2,
                 next_attempt_at = now() + make_interval(secs => $3::double precision),
                 last_error      = $4,
                 leased          = false
             where package_key = $1`,
            [row.package_key, attempts, backoff / 1000, message],
        )
        await insertFetchLog(tx, row.package_key, records)
    })
}

/**
 * Out of attempts. The package is flagged `error` and retried in an hour — unless it already has
 * good data, in which case the failure is recorded but the resolved facts stay served. A flaky
 * refresh must not take a package away from callers.
 *
 * Neither timestamp moves: nothing was fetched, so `fetched_at` and `as_of` still describe the
 * last fetch that worked (or stay null for a package that never had one), and `error` says that
 * the latest attempt did not.
 */
export async function giveUp(
    job: JobContext,
    row: FetchQueueRow,
    message: string,
    records: readonly FetchRecord[],
): Promise<void> {
    job.log.error('giving up on package', {package: row.package_key, error: message})
    await job.db.withTransaction(async tx => {
        await tx.query(
            `update package
             set status        = case when status = 'resolved' then 'resolved' else 'error' end,
                 error         = $2,
                 next_retry_at = now() + ${ERROR_RETRY}
             where package_key = $1
             returning ${notifySettled}`,
            [row.package_key, message],
        )
        await insertFetchLog(tx, row.package_key, records)
        await tx.query(`with ${settleQueueRow('$2')}`, [row.package_key, row.requests])
    })

    // The other terminal status. A request waiting on this package has an answer now — `error`,
    // or the resolved facts this deliberately kept serving — and should not wait out its budget.
    job.events?.settled(row.package_key)
}

/**
 * Re-queues packages whose retry has come due: `not_found` after 24 h, `error` after an hour, and a
 * resolved package whose registry asked to be fetched again (`FetchedPackage.recheckAt`). Runs
 * every 10 minutes, which is granular enough for all three.
 */
export async function sweepRetries(db: Db, log: Logger): Promise<void> {
    const rows = await db.query<{package_key: string}>(
        `with due as (select package_key
                      from package
                      where tracked
                        and next_retry_at is not null
                        and next_retry_at <= now()
                      order by next_retry_at
                      limit 1000),
              queued as (
                  insert into fetch_queue (package_key, priority, requested_at, attempts, next_attempt_at)
                      select package_key, $1::int, now(), 0, now() from due
                      on conflict (package_key) do nothing
                      returning package_key, pg_notify('${CHANNEL_QUEUED}', ''))
         update package
         set next_retry_at = null
         where package_key in (select package_key from due)
         returning package_key`,
        [PRIORITY.retry],
    )
    if (rows.length > 0) log.info('re-queued packages due for retry', {count: rows.length})
}
