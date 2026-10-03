import type {Config} from '../../config.js'
import type {Db} from '../../db/db.js'
import type {ResolverEvents} from '../../events.js'
import {createHttpClient, URGENT_RANK, type FetchRecord, type Rank} from '../../registries/http.js'
import {errorMessage, type Logger, type ParsedPurl, parsePurl} from '@depinder/core'
import type {FetchQueueRow} from '../../db/rows.js'
import {registryFor} from '../../registries/index.js'
import {startLoop, type Loop} from '../loop.js'
import {dequeue, quotas, renewLeases} from './dequeue.js'
import {giveUp, recordFailure, sweepRetries} from './retry.js'
import {writeResult, type JobContext} from './write.js'

/**
 * The demand-fill worker: whatever is in `fetch_queue` gets fetched from its registry and written
 * to `package` / `package_version`.
 *
 * The work is shaped as a bounded pool, not as a batch per tick: up to `fetchConcurrency` package
 * fetches are in flight at once, and every one that settles is replaced straight away by a fresh
 * dequeue of exactly as many rows as there are free slots. Nothing waits for a batch to finish,
 * so a slow package costs one slot instead of holding up everything queued behind it. The queue is
 * only consulted on a timer when it is drained (`IDLE_MS`); while there is work, the next top-up
 * follows the next completion.
 *
 * Politeness is not this file's job — every registry goes through the per-ecosystem limiter in
 * `http.ts`, so the pool can be wider than any single registry would tolerate and still arrive at
 * crates.io one request per second. But a fetch waiting in that limiter still holds its pool slot,
 * so the pool also caps each ecosystem at `fetchSlots(type)`: without it, a queue whose front is
 * three hundred crates fills every slot with cargo at one request a second, and the npm rows behind
 * them wait out all of it while the npm limiter sits idle. Within those caps the queue is still
 * drained by priority.
 *
 * The write side is in `write.ts`, the failure side in `retry.ts`, and the queue statements the
 * pool leases its rows with in `dequeue.ts`.
 */

/** How long to wait before looking at a drained queue again. */
const IDLE_MS = 1_000
const SWEEP_MS = 10 * 60 * 1_000
/**
 * How often the leases of everything in flight are pushed out by another `LEASE`. A fetch that is
 * still running never loses its row — a golang module with four hundred tags, or maven fetching a
 * POM per version, can take longer than any lease — and three heartbeats in a row may fail before
 * one does.
 */
const HEARTBEAT_MS = 30_000

interface DemandFillOptions {
    db: Db
    log: Logger
    config: Config
    /** Package fetches in flight at once. Defaults to `config.fetchConcurrency`. */
    poolSize?: number
    /** How long to wait before looking at a drained queue again. Defaults to `IDLE_MS`. */
    idleMs?: number
    /** How often the leases in flight are renewed. Defaults to `HEARTBEAT_MS`. */
    heartbeatMs?: number
    sweepIntervalMs?: number
    /** The api in this process, if there is one. See `src/resolver/events.ts`. */
    events?: ResolverEvents
}

export function startDemandFill(options: DemandFillOptions): Loop {
    const log = options.log.child({component: 'demand-fill'})
    const fill = startFill({...options, log})
    const sweep = startLoop({
        name: 'retry-sweep',
        intervalMs: options.sweepIntervalMs ?? SWEEP_MS,
        log,
        run: () => sweepRetries(options.db, log),
    })
    // A request that queues work says so, so the pump does not sit out a nap with a demand row
    // waiting. Worth nothing during a bulk run, when the pump never idles; worth the whole nap for
    // the first chunk and for trickle traffic.
    const unsubscribe = options.events?.onQueued(() => fill.wake?.())
    return {
        async stop() {
            unsubscribe?.()
            await Promise.all([fill.stop(), sweep.stop()])
        },
        wake() {
            fill.wake?.()
        },
    }
}

/**
 * The pool. Each top-up asks the queue for exactly as many rows as there are free slots and
 * starts them without waiting; the pump then blocks until a slot frees up, or — when the queue
 * had fewer rows to give than slots to fill — until `idleMs` has passed.
 *
 * A throwing top-up is logged and the pump carries on, and a row that fails to be written keeps
 * its lease and comes back when that runs out: neither is a reason for the worker to stop.
 *
 * Alongside the pump, a heartbeat renews the lease of every row in flight, so a lease only runs
 * out on a worker that has stopped renewing it — one that died — and never under a slow fetch.
 */
function startFill(options: DemandFillOptions & {log: Logger}): Loop {
    const {db, log, config} = options
    const poolSize = options.poolSize ?? config.fetchConcurrency
    const idleMs = options.idleMs ?? IDLE_MS
    const inFlight = new Set<Promise<void>>()
    /** Fetches in flight per purl type; what {@link quotas} measures against `fetchSlots`. */
    const perType = new Map<string, number>()
    /** The rows in flight, by key: what the heartbeat renews. */
    const leased = new Set<string>()
    /** How urgent each fetch in flight is, by key: what a caller asking for one of them raises. */
    const urgencies = new Map<string, Urgency>()
    const unsubscribe = options.events?.onWanted((key, until) => {
        const urgency = urgencies.get(key)
        if (urgency && until > urgency.until) urgency.until = until
    })
    let stopped = false
    let interruptIdle: (() => void) | undefined
    /** A wake that arrived while the pump was between the queue and its nap. */
    let woken = false

    /** Waits out a drained queue, cut short by `stop()` or by `wake()`. */
    const idle = (): Promise<void> =>
        new Promise<void>(resolve => {
            // A row committed while the last dequeue was in flight was not in that answer, and
            // the wake that announced it arrived before there was a nap to cut short. Napping on
            // it anyway is how work sits in a drained queue for a whole second.
            if (woken) {
                woken = false
                resolve()
                return
            }

            const timer = setTimeout(finish, idleMs)
            interruptIdle = finish

            function finish(): void {
                clearTimeout(timer)
                interruptIdle = undefined
                woken = false
                resolve()
            }
        })

    const start = (row: FetchQueueRow): void => {
        const type = row.type
        perType.set(type, (perType.get(type) ?? 0) + 1)
        leased.add(row.package_key)
        const urgency = urgencyOf(row)
        urgencies.set(row.package_key, urgency)
        const done = processRow(row, {db, log, config, events: options.events}, urgency).catch(e => {
            // `processRow` deals with registry failures itself; what reaches here is the database
            // failing underneath it. The heartbeat lets go of the row, and once its lease runs out
            // it comes back.
            log.error('demand-fill tick failed', {error: errorMessage(e)})
        })
        inFlight.add(done)
        void done.then(() => {
            inFlight.delete(done)
            leased.delete(row.package_key)
            urgencies.delete(row.package_key)
            perType.set(type, (perType.get(type) ?? 1) - 1)
            // A nap may be down to the caps rather than to an empty queue — cargo's two slots
            // busy, three hundred crates due — and this completion is what frees one.
            interruptIdle?.()
        })
    }

    const pump = async (): Promise<void> => {
        while (!stopped) {
            const free = poolSize - inFlight.size
            if (free <= 0) {
                await Promise.race(inFlight)
                continue
            }

            const open = quotas(perType)
            if (open.length === 0) {
                // Every ecosystem is at its cap: only a completion frees a slot worth asking the
                // queue for. `inFlight` cannot be empty here, since no cap is zero.
                await Promise.race(inFlight)
                continue
            }

            let rows: FetchQueueRow[]
            try {
                rows = await dequeue(db, free, open)
            } catch (e) {
                log.error('demand-fill tick failed', {error: errorMessage(e)})
                await idle()
                continue
            }
            if (stopped) break

            if (rows.length > 0) {
                log.debug('processing batch', {size: rows.length})
                for (const row of rows) start(row)
            }
            // Fewer rows than slots means the queue is drained, or holds only what the caps keep
            // back, so the next look is on the clock or on the next completion, whichever comes
            // first. Otherwise there is more waiting, and the next top-up follows the next completion.
            if (rows.length < free) await idle()
        }
    }

    const running = pump().catch(e => {
        log.error('demand-fill tick failed', {error: errorMessage(e)})
    })

    const heartbeat = setInterval(() => {
        if (leased.size === 0) return
        renewLeases(db, [...leased]).catch(e => {
            log.warn('lease heartbeat failed', {error: errorMessage(e), leased: leased.size})
        })
    }, options.heartbeatMs ?? HEARTBEAT_MS)
    heartbeat.unref?.()

    return {
        async stop(): Promise<void> {
            stopped = true
            interruptIdle?.()
            await running
            // Leases are held by whatever is still in flight, so let it finish rather than
            // leaving half-written packages for the next worker to wait a lease out for. The
            // heartbeat keeps beating until it has.
            await Promise.all(inFlight)
            clearInterval(heartbeat)
            unsubscribe?.()
        },
        wake(): void {
            if (interruptIdle) interruptIdle()
            else woken = true
        },
    }
}

/**
 * One pass: take as many rows as the pool is wide and process them, awaiting all of it. The
 * worker uses the pool above; this is for tests and for one-shot runs.
 */
export async function runOnce(options: DemandFillOptions & {log: Logger}): Promise<void> {
    const {db, log, config} = options
    const rows = await dequeue(db, options.poolSize ?? config.fetchConcurrency, quotas(new Map()))
    if (rows.length === 0) return

    log.debug('processing batch', {size: rows.length})
    await Promise.all(rows.map(row => processRow(row, {db, log, config, events: options.events})))
}


/**
 * Until when somebody waits for the package a fetch is fetching, in epoch ms; 0 when nobody does.
 * Seeded from the row's `wanted_until` and raised while the fetch runs, when a caller asks for the
 * package then (`events.wanted`).
 */
interface Urgency {
    until: number
}

function urgencyOf(row: FetchQueueRow): Urgency {
    return {until: row.wanted_until?.getTime() ?? 0}
}

/**
 * How a fetch's requests rank in its registry limiter: urgent while somebody waits for it, its
 * queue priority after that — still ahead of the feed and sweep traffic that only looks for news.
 * Read each time a limiter hands out a slot, so it changes with the clock and with `urgency`.
 */
export function fetchRank(urgency: Urgency, priority: number, now: () => number = Date.now): Rank {
    return () => (urgency.until > now() ? URGENT_RANK : priority)
}

// [7] One row, one package: parse key → registry.fetchPackage → write. Throwing here means retry, not crash.
async function processRow(row: FetchQueueRow, job: JobContext, urgency: Urgency = urgencyOf(row)): Promise<void> {
    let key: ParsedPurl
    try {
        key = parsePurl(row.package_key)
    } catch (e) {
        await giveUp(job, row, `unusable package key: ${errorMessage(e)}`, [])
        return
    }

    const registry = registryFor(key.type)
    if (!registry) {
        // Never fires in practice: all eight supported types have a registry. One row's error, not a crash.
        await giveUp(job, row, `no registry implemented for type "${key.type}"`, [])
        return
    }

    const records: FetchRecord[] = []
    const http = createHttpClient({
        type: key.type,
        recorder: record => records.push(record),
        rank: fetchRank(urgency, row.priority),
    })
    const log = job.log.child({package: row.package_key})
    // Freshness is stamped at the start: whatever the registry answers is at least this new, and a
    // change that lands while the fetch is running is the next fetch's to see.
    const startedAt = new Date()

    try {
        const fetched = await registry.fetchPackage(key, {
            http,
            log,
            options: {mavenPerVersionLicenses: job.config.mavenPerVersionLicenses},
        })
        await writeResult(job, row, key, fetched, records, startedAt)
        log.debug(fetched ? 'resolved' : 'not found', {versions: fetched?.versions.length ?? 0})
    } catch (e) {
        await recordFailure(job, row, errorMessage(e), records)
    }
}
