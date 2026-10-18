import {describe, expect, it} from 'vitest'
import {handleResolve} from '../../../../src/resolver/api/resolve/handle.js'
import {GATHER_MS} from '../../../../src/resolver/api/resolve/types.js'
import {createVersionCache} from '../../../../src/resolver/api/version-cache.js'
import {createResolverEvents} from '../../../../src/resolver/events.js'
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

describe('handleResolve, while it waits', () => {
    it('sends what it already has before it starts waiting', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        const sink = new Collector()
        let finished = false

        const answer = handleResolve(
            ask(['pkg:npm/express', 'pkg:npm/brand-new'], {deadlineMs: 15_000}),
            {store, events, ...eventClock()},
            sink,
        ).then(outcome => ((finished = true), outcome))
        await tick()

        // Still waiting for the unknown one, and the known one is already out.
        expect(finished).toBe(false)
        expect(sink.items.map(it => [it.key, it.status])).toEqual([['pkg:npm/express', 'resolved']])

        store.packages.set('pkg:npm/brand-new', packageRow({package_key: 'pkg:npm/brand-new', name: 'brand-new'}))
        events.settled('pkg:npm/brand-new')
        expect(await answer).toBe('done')
        expect(sink.items.map(it => [it.key, it.status])).toEqual([
            ['pkg:npm/express', 'resolved'],
            ['pkg:npm/brand-new', 'resolved'],
        ])
    })

    it('finds a pending package by polling when nothing tells it', async () => {
        const store = new FakeStore()
        const events = createResolverEvents()
        const clock = fakeClock()
        store.onGetPackages = () => {
            if (store.getPackagesCalls === 2) {
                store.packages.set('pkg:npm/brand-new', packageRow({
                    package_key: 'pkg:npm/brand-new',
                    name: 'brand-new',
                    latest_version: '1.0.0',
                }))
                store.versions.set('pkg:npm/brand-new', [version('1.0.0', '2026-09-16T09:00:00Z')])
            }
        }

        // An emitter that never fires is a worker in another process, or another instance.
        const sink = await resolve(ask(['pkg:npm/brand-new@1.0.0'], {deadlineMs: 15_000}), {
            store,
            events,
            ...clock,
            pollIntervalMs: 2_000,
        })

        expect(sink.item('pkg:npm/brand-new')!.status).toBe('resolved')
        expect(sink.item('pkg:npm/brand-new')!.package!.versions).toEqual([version('1.0.0', '2026-09-16T09:00:00Z')])
        expect(clock.elapsed()).toBe(2_000)
        // Removed in the `finally`, so a listener cannot outlive the request that added it.
        expect(events.listeners).toBe(0)
    })

    it('looks as soon as the worker says, after gathering for a moment', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        const clock = eventClock()

        const answer = resolve(ask(['pkg:npm/brand-new@1.0.0'], {deadlineMs: 15_000}), {store, events, ...clock})
        await tick()

        store.packages.set('pkg:npm/brand-new', packageRow({package_key: 'pkg:npm/brand-new', name: 'brand-new'}))
        events.settled('pkg:npm/brand-new')

        const sink = await answer
        expect(sink.item('pkg:npm/brand-new')!.status).toBe('resolved')
        // The gathering window and nothing else: no poll interval was waited out.
        expect(clock.elapsed()).toBe(GATHER_MS)
        // The one look at the database it took to confirm, on top of the first.
        expect(store.getPackagesCalls).toBe(2)
        expect(events.listeners).toBe(0)
    })

    it('reads every package that settles inside the window in one query', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        const sink = new Collector()

        const answer = handleResolve(
            ask(['pkg:npm/a', 'pkg:npm/b', 'pkg:npm/c'], {deadlineMs: 15_000}),
            {store, events, ...eventClock()},
            sink,
        )
        await tick()

        for (const key of ['pkg:npm/a', 'pkg:npm/b']) {
            store.packages.set(key, packageRow({package_key: key}))
            events.settled(key)
        }
        await tick()

        expect(store.packageKeys.slice(1)).toEqual([['pkg:npm/a', 'pkg:npm/b']])
        // Sent as they land: c is still open, and a and b are already out.
        expect(sink.items.map(it => it.key)).toEqual(['pkg:npm/a', 'pkg:npm/b'])
        expect(sink.trailer).toBeUndefined()

        store.packages.set('pkg:npm/c', packageRow({package_key: 'pkg:npm/c'}))
        events.settled('pkg:npm/c')
        expect(await answer).toBe('done')
        expect(store.packageKeys.slice(1)).toEqual([['pkg:npm/a', 'pkg:npm/b'], ['pkg:npm/c']])
    })

    it('keeps one read in flight, and puts what settles during it into the next', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        store.onGetPackages = () => {
            // While a is being read, b lands.
            if (store.getPackagesCalls === 2) {
                store.packages.set('pkg:npm/b', packageRow({package_key: 'pkg:npm/b'}))
                events.settled('pkg:npm/b')
            }
        }

        const answer = resolve(ask(['pkg:npm/a', 'pkg:npm/b'], {deadlineMs: 15_000}), {store, events, ...eventClock()})
        await tick()
        store.packages.set('pkg:npm/a', packageRow({package_key: 'pkg:npm/a'}))
        events.settled('pkg:npm/a')

        const sink = await answer
        expect(store.packageKeys.slice(1)).toEqual([['pkg:npm/a'], ['pkg:npm/b']])
        expect(sink.items.map(it => [it.key, it.status])).toEqual([
            ['pkg:npm/a', 'resolved'],
            ['pkg:npm/b', 'resolved'],
        ])
    })

    it('ignores an event for a package it is not waiting on', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        let finished = false

        const answer = resolve(ask(['pkg:npm/brand-new'], {deadlineMs: 15_000}), {store, events, ...eventClock()})
        void answer.then(() => (finished = true))
        await tick()

        // Every package the worker writes is announced, and a busy worker writes hundreds while
        // one request waits. None of them is this one.
        events.settled('pkg:npm/someone-else')
        await tick()
        expect(finished).toBe(false)
        expect(store.getPackagesCalls).toBe(1)

        store.packages.set('pkg:npm/brand-new', packageRow({package_key: 'pkg:npm/brand-new'}))
        events.settled('pkg:npm/brand-new')

        expect((await answer).item('pkg:npm/brand-new')!.status).toBe('resolved')
    })

    it('sends what is still open at the deadline, once, and then the trailer', async () => {
        const store = new FakeStore()
        const clock = fakeClock()

        const sink = await resolve(ask(['pkg:npm/slow', 'pkg:npm/slow@2.0.0'], {deadlineMs: 2_000}), {
            store,
            ...clock,
            pollIntervalMs: 500,
        })

        expect(sink.items).toEqual([{key: 'pkg:npm/slow', purls: ['pkg:npm/slow', 'pkg:npm/slow@2.0.0'], status: 'pending'}])
        expect(clock.elapsed()).toBe(2_000)
    })

    it('asks for a package\'s versions once and serves the rest from memory', async () => {
        const cache = createVersionCache(10)
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express', latest_version: '4.18.2'}))
        store.versions.set('pkg:npm/express', [version('4.18.2', '2022-10-08T00:00:00Z')])

        const first = await resolve(ask(['pkg:npm/express@4.18.2']), {store, cache})
        const second = await resolve(ask(['pkg:npm/express@4.18.2']), {store, cache})

        // The `package` row is read either way — that is what validates the entry — but the
        // versions are asked for once.
        expect(store.versionKeys).toEqual([['pkg:npm/express']])
        expect(second.items).toEqual(first.items)
    })

    it('asks again once the worker has refetched the package', async () => {
        const cache = createVersionCache(10)
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({
            package_key: 'pkg:npm/express',
            fetched_at: new Date('2026-09-16T10:00:00Z'),
        }))
        store.versions.set('pkg:npm/express', [version('4.18.2', '2022-10-08T00:00:00Z')])

        await resolve(ask(['pkg:npm/express']), {store, cache})

        // A refetch stamps a new fetched_at on the package row in the same transaction that
        // replaces its versions, so the entry stored under the old one is never used again.
        store.packages.set('pkg:npm/express', packageRow({
            package_key: 'pkg:npm/express',
            fetched_at: new Date('2026-09-16T11:00:00Z'),
        }))
        store.versions.set('pkg:npm/express', [
            version('4.18.2', '2022-10-08T00:00:00Z'),
            version('4.19.0', '2024-03-25T00:00:00Z'),
        ])
        const second = await resolve(ask(['pkg:npm/express']), {store, cache})

        expect(store.versionKeys).toEqual([['pkg:npm/express'], ['pkg:npm/express']])
        expect(second.items[0]!.package!.versions.map(v => v[0])).toEqual(['4.18.2', '4.19.0'])
    })
})
