import {describe, expect, it} from 'vitest'
import {handleResolve} from '../../../../src/resolver/api/resolve/handle.js'
import type {ResolveOutcome} from '../../../../src/resolver/api/resolve/types.js'
import {createVersionCache} from '../../../../src/resolver/api/version-cache.js'
import {createResolverEvents} from '../../../../src/resolver/events.js'
import {nullLogger, type Logger} from '../../../../src/shared/log.js'
import {ask, Collector, fakeClock, FakeStore, packageRow, tick, version} from './resolve.helpers.js'

/**
 * A caller that hangs up.
 *
 * Everything after `createPending` is built to be sent, so an abandoned request is worth nothing to
 * anyone and costs one of the api's four pool clients for every read it still makes. These pin
 * that it stops: out of the wait at once, no further read, and no trailer.
 */
describe('handleResolve, when the caller goes away', () => {
    it('breaks out of the wait, reads nothing more, and sends no trailer', async () => {
        const events = createResolverEvents()
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        const controller = new AbortController()
        const sink = new Collector()

        const answer = handleResolve(
            ask(['pkg:npm/express', 'pkg:npm/brand-new@1.0.0'], {deadlineMs: 15_000}),
            // Only the abort can end this wait: neither a poll nor an event ever comes.
            {store, events, signal: controller.signal, now: () => 0, sleep: () => new Promise<void>(() => undefined)},
            sink,
        )
        await tick()
        const versionReads = store.versionKeys.length
        controller.abort()

        expect(await answer).toBe<ResolveOutcome>('abandoned')
        // What was final before it left was sent; nothing after.
        expect(sink.items.map(it => it.key)).toEqual(['pkg:npm/express'])
        expect(sink.trailer).toBeUndefined()
        // The queue row is committed before the wait and stays committed: the fetch is still worth
        // doing for whoever asks next.
        expect(store.created).toEqual([['pkg:npm/brand-new']])
        // One look at the database, the one before the wait. Nothing after it.
        expect(store.getPackagesCalls).toBe(1)
        expect(store.versionKeys.length).toBe(versionReads)
        expect(store.feedCalls).toBe(0)
        expect(events.listeners).toBe(0)
    })

    it('opens nothing for a caller already gone, but still commits the queue rows', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/old', packageRow({package_key: 'pkg:npm/old', confirmed_at: null}))
        const controller = new AbortController()
        controller.abort()
        const sink = new Collector()
        const clock = fakeClock()

        const outcome = await handleResolve(
            ask(['pkg:npm/brand-new', 'pkg:npm/old'], {deadlineMs: 15_000}),
            {store, signal: controller.signal, ...clock},
            sink,
        )

        expect(outcome).toBe('abandoned')
        expect(sink.opened).toBe(0)
        expect(sink.lines).toEqual([])
        expect(store.created).toEqual([['pkg:npm/brand-new']])
        expect(store.refreshed).toEqual([['pkg:npm/old']])
        expect(clock.elapsed()).toBe(0)
        expect(store.versionKeys).toEqual([])
    })

    it('banks the version read it had already paid for, and sends nothing after it', async () => {
        // The likelier shape for a chunk whose packages are all known: the caller is there when the
        // read starts and gone by the time it lands.
        const cache = createVersionCache(10)
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        store.versions.set('pkg:npm/express', [version('1.0.0', null)])
        const controller = new AbortController()
        const versions = store.getVersions.bind(store)
        store.getVersions = async keys => {
            const rows = await versions(keys)
            controller.abort()
            return rows
        }
        const sink = new Collector()

        const outcome = await handleResolve(ask(['pkg:npm/express@1.0.0']), {store, cache, signal: controller.signal}, sink)

        expect(outcome).toBe('abandoned')
        expect(store.versionKeys).toEqual([['pkg:npm/express']])
        expect(sink.lines).toEqual([])
        expect(store.feedCalls).toBe(0)
        // What the read cost is kept, so the caller who comes back for it pays nothing.
        expect(cache.get('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}).fetched_at!))
            .toEqual([version('1.0.0', null)])
    })

    it('says so once, at debug', async () => {
        const store = new FakeStore()
        const controller = new AbortController()
        const debug: {msg: string; fields?: Record<string, unknown>}[] = []
        const log: Logger = {...nullLogger, debug: (msg, fields) => void debug.push({msg, fields}), child: () => log}

        const answer = handleResolve(
            ask(['pkg:npm/brand-new'], {deadlineMs: 15_000}),
            {store, log, signal: controller.signal, now: () => 0, sleep: () => new Promise<void>(() => undefined)},
            new Collector(),
        )
        await tick()
        controller.abort()

        expect(await answer).toBe('abandoned')
        // One line, and it is the abandonment rather than a 500 or a served request.
        expect(debug).toHaveLength(1)
        expect(debug[0]!.msg).toBe('resolve abandoned, caller gone')
        expect(debug[0]!.fields).toMatchObject({purls: 1, packages: 1, open: 1, sent: 0})
    })
})
