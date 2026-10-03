import type {Db} from '../../db/db.js'
import {fetchSlots} from '../../registries/http.js'
import {SUPPORTED_TYPES} from '../../../shared/purl.js'
import type {FetchQueueRow} from '../../db/rows.js'

/**
 * How long a dequeued row stays invisible to other workers without a heartbeat. It is what a worker
 * that dies mid-fetch costs its rows, not a bound on how long a fetch may take: see `HEARTBEAT_MS`.
 */
const LEASE = "interval '2 minutes'"

/**
 * Pushes the lease of every given row out to a full `LEASE` from now. One statement for all.
 *
 * Only rows still `leased`: a heartbeat can be waiting on the row lock of the transaction that
 * settles one of them, and must not undo the "due now" or the backoff that transaction wrote.
 */
export async function renewLeases(db: Db, keys: readonly string[]): Promise<void> {
    await db.query(
        `update fetch_queue
         set next_attempt_at = now() + ${LEASE}
         where package_key = any($1::text[])
           and leased`,
        [keys],
    )
}

/**
 * The queue's order, as both halves of `dequeue` sort by it. `urgent_until` is `wanted_until` while
 * it is still ahead and null once it has passed — nobody is waiting any more, and the row falls
 * back to its priority. `nulls last` puts every row nobody waits for after every row somebody does.
 */
const URGENT_FIRST = 'urgent_until nulls last, priority, requested_at'

/** One ecosystem's free slots: how many of its rows the next dequeue may take. */
interface Quota {
    type: string
    n: number
}

/** The free slots of every ecosystem that has any, given what is in flight per type. */
export function quotas(inFlight: ReadonlyMap<string, number>): Quota[] {
    const open: Quota[] = []
    for (const type of SUPPORTED_TYPES) {
        const n = fetchSlots(type) - (inFlight.get(type) ?? 0)
        if (n > 0) open.push({type, n})
    }
    return open
}

/**
 * [6] The other end of [3]: the pool drains fetch_queue most important first, within each
 * ecosystem's free slots. Most important is a row somebody is waiting for — `wanted_until` still
 * ahead — and of those the one whose caller gives up soonest; then priority, demand and feed 20 >
 * refresh 30 > retry 50; then age.
 *
 * Still one statement: each ecosystem offers up to its quota of due rows, best first, and the best
 * `limit` of everything offered are leased. Rows offered but not taken were only locked, and the
 * locks end with the statement. `skip locked` is what lets any number of workers do this at once.
 * The order reads the clock, so no index serves it; one ecosystem's due rows are sorted instead,
 * which at the queue's size is nothing.
 */
export async function dequeue(db: Db, limit: number, open: readonly Quota[]): Promise<FetchQueueRow[]> {
    return db.query<FetchQueueRow>(
        `with picked as (select c.package_key
                         from unnest($2::text[], $3::int[]) as t(type, n)
                         cross join lateral (select package_key, priority, requested_at,
                                                    case when wanted_until > now() then wanted_until end as urgent_until
                                             from fetch_queue
                                             where type = t.type
                                               and next_attempt_at <= now()
                                             order by ${URGENT_FIRST}
                                             limit t.n
                                             for update skip locked) c
                         order by ${URGENT_FIRST}
                         limit $1)
         update fetch_queue q
         set next_attempt_at = now() + ${LEASE},
             leased          = true
         from picked
         where q.package_key = picked.package_key
         returning q.*`,
        [limit, open.map(q => q.type), open.map(q => q.n)],
    )
}
