import {describe, expect, it} from 'vitest'
import {handleResolve} from '../../../../src/resolver/api/resolve/handle.js'
import type {ResolveDeps} from '../../../../src/resolver/api/resolve/types.js'
import type {ResolveStore} from '../../../../src/resolver/api/store.js'
import {createResolverEvents} from '../../../../src/resolver/events.js'
import type {ResolvePackageRow} from '../../../../src/resolver/db/rows.js'
import {
    ask,
    Collector,
    eventClock,
    fakeClock,
    FakeStore,
    packageRow,
    resolve,
    tick,
    version,
} from './resolve.helpers.js'

describe('handleResolve, against a max age', () => {
    const NOW = new Date('2026-10-01T12:00:00Z').getTime()
    const HOUR = 3_600_000
    const at = (msAgo: number): Date => new Date(NOW - msAgo)
    const clock = (store: ResolveStore): ResolveDeps => ({store, ...fakeClock(NOW)})

    function known(store: FakeStore, key: string, overrides: Partial<ResolvePackageRow> = {}): void {
        store.packages.set(key, packageRow({package_key: key, name: key.split('/').pop()!, ...overrides}))
        store.versions.set(key, [version('1.0.0', '2020-01-01T00:00:00Z')])
    }

    it('wants everything it waits for until its deadline, including what others queued', async () => {
        const store = new FakeStore()
        // Pending on a fetch another request queued, stale and already being refreshed, stale and
        // not queued, and never seen: the request waits for all four.
        store.packages.set('pkg:npm/others', packageRow({package_key: 'pkg:npm/others', status: 'pending', queued: true}))
        known(store, 'pkg:npm/refreshing', {confirmed_at: at(48 * HOUR), queued: true})
        known(store, 'pkg:npm/stale', {confirmed_at: at(48 * HOUR)})

        await resolve(
            ask(['pkg:npm/others', 'pkg:npm/refreshing', 'pkg:npm/stale', 'pkg:npm/new'], {deadlineMs: 10_000}),
            clock(store),
        )

        const until = new Date(NOW + 10_000)
        expect(store.deadlines).toEqual([
            {call: 'queueRefresh', until},
            {call: 'createPending', until},
            {call: 'markWanted', until},
        ])
        expect(store.refreshed).toEqual([['pkg:npm/stale']])
        expect(store.created).toEqual([['pkg:npm/new']])
        expect(store.markedWanted).toEqual([['pkg:npm/others', 'pkg:npm/refreshing']])
    })

    it('wants nothing when it will not wait', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/others', packageRow({package_key: 'pkg:npm/others', status: 'pending', queued: true}))
        known(store, 'pkg:npm/stale', {confirmed_at: at(48 * HOUR)})

        await resolve(ask(['pkg:npm/others', 'pkg:npm/stale', 'pkg:npm/new'], {deadlineMs: 0}), clock(store))

        expect(store.deadlines).toEqual([
            {call: 'queueRefresh', until: null},
            {call: 'createPending', until: null},
        ])
        expect(store.markedWanted).toEqual([])
    })

    it('answers a package confirmed within the max age as resolved, and queues nothing', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/fresh', {confirmed_at: at(23 * HOUR)})

        const sink = await resolve(ask(['pkg:npm/fresh@1.0.0'], {maxAgeS: 86_400}), clock(store))

        expect(sink.item('pkg:npm/fresh')!.status).toBe('resolved')
        expect(store.refreshed).toEqual([])
    })

    it('queues an older one, and with no time to wait sends its last facts as refreshing', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/old', {confirmed_at: at(25 * HOUR)})

        const sink = await resolve(ask(['pkg:npm/old@1.0.0'], {maxAgeS: 86_400}), clock(store))

        expect(sink.item('pkg:npm/old')).toMatchObject({
            status: 'refreshing',
            purls: ['pkg:npm/old@1.0.0'],
            package: {versions: [version('1.0.0', '2020-01-01T00:00:00Z')], confirmed_at: at(25 * HOUR).toISOString()},
        })
        expect(store.refreshed).toEqual([['pkg:npm/old']])
        // Known packages are never created again.
        expect(store.created).toEqual([])
    })

    it('holds a stale package, and sends it resolved once its refetch lands', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        known(store, 'pkg:npm/old', {confirmed_at: at(48 * HOUR)})
        const sink = new Collector()

        const answer = handleResolve(
            ask(['pkg:npm/old'], {deadlineMs: 10_000, maxAgeS: 86_400}),
            {store, events, ...eventClock(NOW)},
            sink,
        )
        await tick()
        // Queued, and nothing sent for it yet: the refetch may still land in time.
        expect(store.refreshed).toEqual([['pkg:npm/old']])
        expect(sink.items).toEqual([])

        known(store, 'pkg:npm/old', {fetched_at: new Date(NOW), confirmed_at: new Date(NOW)})
        store.versions.set('pkg:npm/old', [version('1.0.0', '2020-01-01T00:00:00Z'), version('1.1.0', null)])
        events.settled('pkg:npm/old')

        expect(await answer).toBe('done')
        expect(sink.items).toHaveLength(1)
        expect(sink.items[0]!.status).toBe('resolved')
        expect(sink.items[0]!.package!.versions.map(v => v[0])).toEqual(['1.0.0', '1.1.0'])
    })

    it('does not count a stale package as landed until its fetched_at moves', async () => {
        // The feed vouching for it, or a poll's 304, moves `confirmed_at` — not a refetch.
        const store = new FakeStore()
        known(store, 'pkg:npm/old', {confirmed_at: at(48 * HOUR)})
        const deps = clock(store)
        store.onGetPackages = () => {
            if (store.getPackagesCalls === 2) known(store, 'pkg:npm/old', {confirmed_at: new Date(NOW)})
        }

        const sink = await resolve(ask(['pkg:npm/old'], {deadlineMs: 4_000, maxAgeS: 86_400}), {...deps, pollIntervalMs: 2_000})

        expect(sink.item('pkg:npm/old')!.status).toBe('refreshing')
        // Looked at once, at 2 s; at 4 s the deadline is up and it goes out with what it had.
        expect(store.getPackagesCalls).toBe(2)
    })

    it('sends a stale package whose refresh gave up as refreshing, without waiting out the deadline', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        known(store, 'pkg:npm/flaky', {confirmed_at: at(48 * HOUR)})

        const answer = resolve(ask(['pkg:npm/flaky'], {deadlineMs: 10_000, maxAgeS: 86_400}), {store, events, ...eventClock(NOW)})
        await tick()
        // What the worker's `giveUp` leaves on a package that had good data.
        known(store, 'pkg:npm/flaky', {
            confirmed_at: at(48 * HOUR),
            error: 'registry.npmjs.org returned 503',
            next_retry_at: new Date(NOW + HOUR),
        })
        events.settled('pkg:npm/flaky')

        const sink = await answer
        expect(sink.item('pkg:npm/flaky')).toMatchObject({status: 'refreshing', package: {versions: [version('1.0.0', '2020-01-01T00:00:00Z')]}})
        expect(sink.item('pkg:npm/flaky')!.reason).toBeUndefined()
    })

    it('sends a stale package the registry has since dropped as not_found', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        known(store, 'pkg:npm/dropped', {confirmed_at: at(48 * HOUR)})

        const answer = resolve(ask(['pkg:npm/dropped'], {deadlineMs: 10_000, maxAgeS: 86_400}), {store, events, ...eventClock(NOW)})
        await tick()
        known(store, 'pkg:npm/dropped', {status: 'not_found'})
        events.settled('pkg:npm/dropped')

        expect((await answer).items).toEqual([{key: 'pkg:npm/dropped', purls: ['pkg:npm/dropped'], status: 'not_found'}])
    })

    it('counts a package nothing has ever confirmed as stale', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/unconfirmed', {confirmed_at: null})

        const sink = await resolve(ask(['pkg:npm/unconfirmed'], {maxAgeS: 86_400}), clock(store))

        expect(sink.item('pkg:npm/unconfirmed')!.status).toBe('refreshing')
        expect(store.refreshed).toEqual([['pkg:npm/unconfirmed']])
    })

    it('measures the max age the caller sent, not the default', async () => {
        const store = new FakeStore()
        known(store, 'pkg:maven/org.example/lib', {type: 'maven', confirmed_at: at(2 * HOUR)})

        const hour = await resolve(ask(['pkg:maven/org.example/lib'], {maxAgeS: 3600}), clock(store))
        expect(hour.items[0]!.status).toBe('refreshing')

        const day = await resolve(ask(['pkg:maven/org.example/lib'], {maxAgeS: 86_400}), clock(store))
        expect(day.items[0]!.status).toBe('resolved')
    })

    it('does not queue a stale package that is already queued, and waits for that fetch instead', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/queued', {confirmed_at: at(48 * HOUR), queued: true})
        const deps = clock(store)
        store.onGetPackages = () => {
            if (store.getPackagesCalls === 2) known(store, 'pkg:npm/queued', {fetched_at: new Date(NOW), confirmed_at: new Date(NOW)})
        }

        const sink = await resolve(ask(['pkg:npm/queued'], {deadlineMs: 10_000, maxAgeS: 86_400}), deps)

        expect(store.refreshed).toEqual([])
        expect(sink.item('pkg:npm/queued')!.status).toBe('resolved')
    })

    it('sends a stale package at once as refreshing when its retry falls after the deadline', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/flaky', {
            confirmed_at: at(48 * HOUR),
            error: 'registry.npmjs.org returned 503',
            next_retry_at: new Date(NOW + HOUR),
        })
        const deps = clock(store)

        const sink = await resolve(ask(['pkg:npm/flaky'], {deadlineMs: 10_000, maxAgeS: 86_400}), deps)

        expect(sink.item('pkg:npm/flaky')!.status).toBe('refreshing')
        // Left to its own retry schedule, and not waited for: it cannot land in time.
        expect(store.refreshed).toEqual([])
        expect(store.getPackagesCalls).toBe(1)
    })

    it('holds a stale package whose scheduled refetch falls inside the deadline, without queueing it', async () => {
        const store = new FakeStore()
        // A golang re-check due in five seconds, inside a ten-second deadline.
        known(store, 'pkg:golang/example.com/mod', {
            type: 'golang',
            confirmed_at: at(48 * HOUR),
            next_retry_at: new Date(NOW + 5_000),
        })
        const deps = clock(store)
        store.onGetPackages = () => {
            if (store.getPackagesCalls === 4) {
                known(store, 'pkg:golang/example.com/mod', {type: 'golang', fetched_at: new Date(NOW + 6_000)})
            }
        }

        const sink = await resolve(ask(['pkg:golang/example.com/mod'], {deadlineMs: 10_000, maxAgeS: 86_400}), deps)

        expect(store.refreshed).toEqual([])
        expect(sink.items[0]!.status).toBe('resolved')
    })

    it('never touches not_found or error, however old', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/gone', {status: 'not_found', confirmed_at: at(1000 * HOUR)})
        known(store, 'pkg:npm/broken', {status: 'error', error: 'boom', confirmed_at: null, fetched_at: null})

        const sink = await resolve(ask(['pkg:npm/gone', 'pkg:npm/broken'], {maxAgeS: 0}), clock(store))

        expect(sink.items.map(r => r.status)).toEqual(['not_found', 'error'])
        expect(store.refreshed).toEqual([])
    })

    it('queues every stale package of a request in one call, once each', async () => {
        const store = new FakeStore()
        known(store, 'pkg:npm/a', {confirmed_at: at(30 * HOUR)})
        known(store, 'pkg:npm/b', {confirmed_at: at(1 * HOUR)})
        known(store, 'pkg:npm/c', {confirmed_at: at(30 * HOUR)})

        const sink = await resolve(
            ask(['pkg:npm/a@1.0.0', 'pkg:npm/a@2.0.0', 'pkg:npm/b', 'pkg:npm/c'], {maxAgeS: 86_400}),
            clock(store),
        )

        expect(sink.items.map(r => [r.key, r.status])).toEqual([
            ['pkg:npm/b', 'resolved'],
            ['pkg:npm/a', 'refreshing'],
            ['pkg:npm/c', 'refreshing'],
        ])
        expect(store.refreshed).toEqual([['pkg:npm/a', 'pkg:npm/c']])
    })

    it('answers a package that lands during the wait as resolved, even with a max age of 0', async () => {
        const store = new FakeStore()
        store.onGetPackages = () => {
            if (store.getPackagesCalls < 2) return
            known(store, 'pkg:npm/new', {confirmed_at: at(1)})
        }

        const sink = await resolve(ask(['pkg:npm/new'], {deadlineMs: 10_000, maxAgeS: 0}), clock(store))

        expect(sink.item('pkg:npm/new')!.status).toBe('resolved')
        expect(store.refreshed).toEqual([])
    })
})
