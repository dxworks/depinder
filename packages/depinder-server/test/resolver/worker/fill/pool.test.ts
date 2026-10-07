import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {setTimeout as sleep} from 'node:timers/promises'
import {limiter, resetLimiters, URGENT_RANK} from '../../../../src/resolver/registries/http.js'
import {nullLogger} from '@depinder/core'
import {createResolverEvents} from '../../../../src/resolver/events.js'
import {quotas} from '../../../../src/resolver/worker/fill/dequeue.js'
import {fetchRank, startDemandFill} from '../../../../src/resolver/worker/fill/pool.js'
import {active, config, fakeDb, packages, packument, peak, resetCounters, stubFetch, waitFor} from './fill.helpers.js'

/**
 * The demand-fill worker's shape: a bounded pool of package fetches that tops itself up as each one
 * settles. The point of the pool is that a slow package costs one slot and nothing else, so the
 * first test here is the one that would fail against a worker that awaits a whole batch per tick.
 */

beforeEach(() => {
    resetCounters()
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('demand-fill pool', () => {
    it('carries on past a package that never finishes instead of waiting for its batch', async () => {
        const {db, dequeues, written} = fakeDb(['pkg:npm/slow', ...packages(24)])
        let release!: () => void
        const held = new Promise<void>(resolve => {
            release = resolve
        })
        stubFetch(name => (name === 'slow' ? held : Promise.resolve()))

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 4,
            idleMs: 5,
            sweepIntervalMs: 60_000,
        })

        // `slow` is dequeued first and holds its slot for the whole of this wait. A worker that
        // awaited the batch it dequeued would still be on its first batch here, having written
        // three packages; the pool writes twenty through the three slots beside it.
        await waitFor(() => written.length >= 20, 'twenty packages to be written')
        expect(written).not.toContain('pkg:npm/slow')
        expect(active).toBe(1)
        expect(dequeues.length).toBeGreaterThan(1)

        release()
        await waitFor(() => written.length === 25, 'every package to be written')
        expect(written).toContain('pkg:npm/slow')
        await worker.stop()
    })

    it('keeps the pool full and never wider than it is', async () => {
        const {db, dequeues, written} = fakeDb(packages(20))
        stubFetch(() => sleep(10))

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 4,
            idleMs: 5,
            sweepIntervalMs: 60_000,
        })
        await waitFor(() => written.length === 20, 'every package to be written')
        await worker.stop()

        expect(peak).toBe(4)
        // Every top-up asks for exactly the free slots, never a fixed batch.
        expect(Math.max(...dequeues)).toBe(4)
        expect(dequeues.length).toBeGreaterThan(5)
    })

    it('lets the work in flight finish when it stops, and takes no more', async () => {
        const {db, dequeues, written} = fakeDb(packages(8))
        stubFetch(() => sleep(20))

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 4,
            idleMs: 5,
            sweepIntervalMs: 60_000,
        })
        await waitFor(() => active === 4, 'the pool to fill')

        const taken = dequeues.length
        await worker.stop()
        expect(written).toHaveLength(4)
        expect(active).toBe(0)

        await sleep(30)
        expect(dequeues.length).toBe(taken)
        expect(written).toHaveLength(4)
    })
})

describe('demand-fill fairness', () => {
    it('offers every ecosystem twice its limiter, less what it has in flight', () => {
        const open = new Map(quotas(new Map([['cargo', 2], ['npm', 5]])).map(q => [q.type, q.n]))
        expect(open.has('cargo')).toBe(false)
        expect(open.get('npm')).toBe(11)
        expect(open.get('maven')).toBe(8)
        expect(open.get('pypi')).toBe(8)
        expect(open.get('golang')).toBe(16)
    })

    it('does not let a front of cargo hold up the npm behind it', async () => {
        const crates = Array.from({length: 30}, (_, i) => `pkg:cargo/c${i}`)
        const {db, written, remaining} = fakeDb([...crates, ...packages(10)])
        let release!: () => void
        const held = new Promise<void>(resolve => {
            release = resolve
        })
        // Every crate hangs, the way thirty crates behind a one-per-second limiter would.
        vi.stubGlobal('fetch', async (input: string | URL) => {
            const url = String(input)
            if (url.includes('crates.io')) {
                await held
                return new Response('{}', {status: 500})
            }
            const name = url.slice(url.lastIndexOf('/') + 1)
            return new Response(JSON.stringify(packument(name)), {
                status: 200,
                headers: {'content-type': 'application/json'},
            })
        })

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 20,
            idleMs: 5,
            sweepIntervalMs: 60_000,
        })

        // Without the cap the first dequeue is twenty crates and npm waits for all thirty.
        await waitFor(() => written.length === 10, 'the npm packages to be written')
        expect(remaining.filter(key => key.startsWith('pkg:cargo/'))).toHaveLength(28)

        release()
        await worker.stop()
    })
})

describe('demand-fill urgency', () => {
    it('ranks a fetch urgent until its deadline, then by its queue priority', () => {
        let now = 1_000
        const urgency = {until: 5_000}
        const rank = fetchRank(urgency, 30, () => now)
        expect(rank()).toBe(URGENT_RANK)
        now = 5_000
        expect(rank()).toBe(30)
        // A caller asks while it runs: urgent again, until the new deadline.
        urgency.until = 9_000
        expect(rank()).toBe(URGENT_RANK)
    })

    it('lets a fetch somebody waits for through the limiter first, also one wanted while it waited', async () => {
        // Every npm slot is taken, so the three fetches queue in the limiter: a, b, c, in that order.
        let release!: () => void
        const held = new Promise<void>(resolve => (release = resolve))
        const blockers = Array.from({length: 8}, () => limiter('npm').run(() => held))
        const fetched: string[] = []
        vi.stubGlobal('fetch', async (input: string | URL) => {
            const url = String(input)
            const name = url.slice(url.lastIndexOf('/') + 1)
            fetched.push(name)
            return new Response(JSON.stringify(packument(name)), {status: 200, headers: {'content-type': 'application/json'}})
        })
        const events = createResolverEvents()
        // `c` was queued by a caller who is still waiting; `b` is asked for once it is in flight.
        const {db, written, remaining} = fakeDb(
            ['pkg:npm/a', 'pkg:npm/b', 'pkg:npm/c'],
            new Map([['pkg:npm/c', new Date(Date.now() + 60_000)]]),
        )
        const worker = startDemandFill({db, log: nullLogger, config, events, poolSize: 4, idleMs: 5, sweepIntervalMs: 60_000})
        await waitFor(() => remaining.length === 0, 'the three fetches to start')
        await sleep(10) // each is now waiting in the npm limiter
        expect(fetched).toEqual([])
        events.wanted('pkg:npm/b', Date.now() + 60_000)
        events.wanted('pkg:npm/elsewhere', Date.now() + 60_000) // not in flight here: nothing to do

        release()
        await Promise.all(blockers)
        await waitFor(() => written.length === 3, 'all three to be written')
        await worker.stop()
        // The two somebody waits for, in the order they came; then the one nobody does.
        expect(fetched).toEqual(['b', 'c', 'a'])
    })
})

describe('demand-fill lease heartbeat', () => {
    it('renews the rows in flight, only those, and lets go of a row once it is done', async () => {
        const {db, written, heartbeats} = fakeDb(['pkg:npm/slow', 'pkg:npm/quick'])
        let release!: () => void
        const held = new Promise<void>(resolve => {
            release = resolve
        })
        stubFetch(name => (name === 'slow' ? held : Promise.resolve()))

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 4,
            idleMs: 5,
            heartbeatMs: 10,
            sweepIntervalMs: 60_000,
        })
        await waitFor(() => written.includes('pkg:npm/quick') && heartbeats.length >= 3, 'three heartbeats')
        // `quick` was written long before the third beat; only `slow` is still being renewed.
        expect(heartbeats.at(-1)).toEqual(['pkg:npm/slow'])

        release()
        await waitFor(() => written.length === 2, 'both packages to be written')
        const beats = heartbeats.length
        await sleep(40)
        // Nothing in flight, nothing to renew: an idle worker costs the database no heartbeats.
        expect(heartbeats.length).toBe(beats)
        await worker.stop()
    })

    it('keeps beating while stop() waits for the work in flight', async () => {
        const {db, written, heartbeats} = fakeDb(['pkg:npm/slow'])
        let release!: () => void
        const held = new Promise<void>(resolve => {
            release = resolve
        })
        stubFetch(() => held)

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 4,
            idleMs: 5,
            heartbeatMs: 10,
            sweepIntervalMs: 60_000,
        })
        await waitFor(() => active === 1, 'the fetch to start')

        const stopping = worker.stop()
        const beats = heartbeats.length
        await waitFor(() => heartbeats.length >= beats + 2, 'heartbeats during shutdown')

        release()
        await stopping
        expect(written).toEqual(['pkg:npm/slow'])
        const after = heartbeats.length
        await sleep(40)
        expect(heartbeats.length).toBe(after)
    })
})

describe('waking the pump', () => {
    it('goes back to the queue when it is told to, instead of finishing its nap', async () => {
        const {db, dequeues} = fakeDb([])
        const events = createResolverEvents()
        stubFetch(() => Promise.resolve())

        const worker = startDemandFill({
            db,
            log: nullLogger,
            config,
            poolSize: 4,
            // A nap far longer than this test: only a wake can end it.
            idleMs: 60_000,
            sweepIntervalMs: 60_000,
            events,
        })
        await waitFor(() => dequeues.length === 1, 'the first look at an empty queue')

        worker.wake!()
        await waitFor(() => dequeues.length >= 2, 'a second look without waiting out the nap')

        // And the api reaches the same handle through the events object it shares with the worker.
        events.queued()
        await waitFor(() => dequeues.length >= 3, 'a third look, asked for by the api side')

        await worker.stop()
    })
})
