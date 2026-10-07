import type {Queryable} from './db.js'
import {CHANNEL_QUEUED} from './notify.js'

/**
 * `fetch_queue` is the message queue between whoever asks for a package and the worker that
 * fetches it: requests, feeds and sweeps only add rows, the worker alone takes them. "The fetch
 * queue" in docs/resolver-internals.md states what it guarantees; this file is the adding side.
 */

/**
 * `fetch_queue` priorities. Lower runs first.
 *
 * Urgency is not one of them. A package somebody is waiting for right now is urgent because of its
 * `wanted_until` — the deadline of the `/resolve` that asked — and outranks every one of these
 * until that deadline passes; see `dequeue`. After that nobody is waiting, and what is left is
 * this order: something asked for, or news from a feed, before the refresh of a package a request
 * found stale, before a scheduled retry. An ask whose caller has stopped waiting is worth exactly
 * what a feed event is — both are a known reason to fetch — while a stale package may well not
 * have changed at all, and its caller already has its last facts.
 */
export const PRIORITY = {
    demand: 20,
    feed: 20,
    refresh: 30,
    retry: 50,
} as const

/**
 * Adds packages to the queue.
 *
 * An already-queued package keeps its schedule: `next_attempt_at` is deliberately left alone so
 * that a package sitting in retry backoff is not pulled forward by every new request for it,
 * which is exactly the hammering the backoff exists to prevent. Priority and age do improve,
 * so a demand request does jump ahead of a retry already in the queue. So does `wanted_until`:
 * the later deadline wins, and `greatest` skips nulls, so a feed event never clears a caller's.
 *
 * `requests` always goes up by one. The row may belong to a fetch that is running at this moment,
 * and that fetch deletes it only if the count is still the one it dequeued — so a feed event for a
 * package mid-fetch keeps the row, and the package is fetched once more.
 *
 * It also notifies {@link CHANNEL_QUEUED}, from inside the statement, so a worker in another
 * process hears of the work when — and only if — the transaction carrying it commits.
 *
 * The keys are sorted and deduplicated here rather than by `select distinct` in the statement, and
 * that is a correctness fix, not a tidy-up. `on conflict do update` takes a row lock on every key
 * it touches and holds it to the end of the transaction, in the order the rows arrive; a
 * `HashAggregate` behind `distinct` picks that order out of the hash table, so two callers carrying
 * the same package could take the two locks in opposite orders and deadlock. Sorted input inserted
 * in input order gives every caller the same lock order instead. See {@link sortedUnique}.
 */
export async function enqueue(
    db: Queryable,
    packageKeys: readonly string[],
    priority: number,
    wantedUntil: Date | null = null,
): Promise<void> {
    const keys = sortedUnique(packageKeys)
    if (keys.length === 0) return
    await db.query(
        `with queued as (insert into fetch_queue (package_key, priority, requested_at, attempts, next_attempt_at,
                                                 wanted_until)
                         select t.key, $2::int, now(), 0, now(), $3::timestamptz
                         from unnest($1::text[]) as t(key)
                         on conflict (package_key) do update
                             set priority     = least(fetch_queue.priority, excluded.priority),
                                 requested_at = least(fetch_queue.requested_at, excluded.requested_at),
                                 requests     = fetch_queue.requests + 1,
                                 wanted_until = greatest(fetch_queue.wanted_until, excluded.wanted_until))
         select pg_notify('${CHANNEL_QUEUED}', '')`,
        [keys, priority, wantedUntil],
    )
}

/**
 * Sorted, with duplicates dropped: the one thing that makes a multi-row insert's lock order the
 * same for every writer, and so the thing that keeps two of them from deadlocking each other.
 *
 * The deduplication is not optional either — `on conflict do update` refuses to touch the same row
 * twice in one statement — which is what `select distinct` used to be there for.
 */
export function sortedUnique(keys: readonly string[]): string[] {
    return [...new Set(keys)].sort()
}
