import {describe, expect, it} from 'vitest'
import {handleResolve} from '../../../../src/resolver/api/resolve/handle.js'
import {nullLogger, type Logger} from '@depinder/core'
import {ask, Collector, fakeClock, FakeStore, packageRow, resolve, version} from './resolve.helpers.js'

describe('handleResolve', () => {
    it('answers a known package with one line carrying its versions', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({
            package_key: 'pkg:npm/express',
            licenses: ['MIT'],
            latest_version: '4.18.2',
            latest_prerelease_version: '5.0.0-alpha.8',
            description: 'web framework',
        }))
        store.versions.set('pkg:npm/express', [
            version('4.17.1', '2019-05-25T00:00:00Z'),
            // Its own licenses differ from the package's ['MIT'], so the tuple carries them.
            version('4.18.2', '2022-10-08T00:00:00Z', 0, ['MIT', 'Apache-2.0']),
        ])

        const sink = await resolve(ask(['pkg:npm/express@4.18.2']), {store})

        expect(sink.items).toHaveLength(1)
        const item = sink.items[0]!
        expect(Object.keys(item)).toEqual(['key', 'purls', 'status', 'package'])
        expect(item).toMatchObject({key: 'pkg:npm/express', purls: ['pkg:npm/express@4.18.2'], status: 'resolved'})
        expect(item.package!.latest).toEqual({version: '4.18.2', released_at: '2022-10-08T00:00:00.000Z'})
        expect(item.package!.latest_prerelease).toEqual({version: '5.0.0-alpha.8', released_at: null})
        // The tuples go out exactly as the query built them.
        expect(item.package!.versions).toEqual([
            ['4.17.1', 1558742400, 0],
            ['4.18.2', 1665187200, 0, ['MIT', 'Apache-2.0']],
        ])
        expect(item.package!.as_of).toBe('2026-09-16T09:59:00.000Z')
        expect(store.created).toEqual([])
    })

    it('keeps a missing release date null and an explicit empty license list empty', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({
            package_key: 'pkg:npm/express',
            licenses: ['MIT'],
            latest_version: '1.0.0',
        }))
        store.versions.set('pkg:npm/express', [version('1.0.0', null), version('2.0.0', '2022-10-08T00:00:00Z', 0, [])])

        const sink = await resolve(ask(['pkg:npm/express@1.0.0']), {store})

        const payload = sink.item('pkg:npm/express')!.package!
        expect(payload.latest).toEqual({version: '1.0.0', released_at: null})
        expect(payload.versions).toEqual([['1.0.0', null, 0], ['2.0.0', 1665187200, 0, []]])
    })

    it('sends one line per package, carrying every purl that named it exactly as it was sent', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        store.versions.set('pkg:npm/express', [version('4.17.1', '2019-05-25T00:00:00Z')])

        const purls = ['pkg:npm/express@4.17.1', 'pkg:npm/express@4.18.2', 'pkg:npm/Express', 'pkg:npm/express@4.17.1']
        const sink = await resolve(ask(purls), {store})

        expect(sink.items).toHaveLength(1)
        expect(sink.items[0]!.purls).toEqual(purls)
        expect(store.versionKeys).toEqual([['pkg:npm/express']])
    })

    it('queues an unknown package and, with no time to wait, sends it as pending', async () => {
        const store = new FakeStore()
        const sink = await resolve(ask(['pkg:npm/brand-new']), {store})

        expect(store.created).toEqual([['pkg:npm/brand-new']])
        expect(sink.items).toEqual([{key: 'pkg:npm/brand-new', purls: ['pkg:npm/brand-new'], status: 'pending'}])
    })

    it('gives each unusable purl its own invalid line, first', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))

        const sink = await resolve(ask(['pkg:npm/express', 'nonsense', 'pkg:deb/debian/curl@7.5', 'nonsense']), {store})

        expect(sink.items.map(it => [it.key, it.status, it.purls])).toEqual([
            [null, 'invalid', ['nonsense']],
            [null, 'invalid', ['pkg:deb/debian/curl@7.5']],
            [null, 'invalid', ['nonsense']],
            ['pkg:npm/express', 'resolved', ['pkg:npm/express']],
        ])
        expect(sink.items[0]!.reason).toBeTruthy()
        expect(sink.items[1]!.reason).toMatch(/unsupported purl type "deb"/)
        expect(store.created).toEqual([])
    })

    it('reports a package the worker could not fetch, with the reason', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/broken', packageRow({
            package_key: 'pkg:npm/broken',
            status: 'error',
            error: 'registry.npmjs.org returned 500',
        }))
        store.packages.set('pkg:npm/gone', packageRow({package_key: 'pkg:npm/gone', status: 'not_found'}))

        const sink = await resolve(ask(['pkg:npm/broken@1.0.0', 'pkg:npm/gone']), {store})

        expect(sink.item('pkg:npm/broken')).toEqual({
            key: 'pkg:npm/broken',
            purls: ['pkg:npm/broken@1.0.0'],
            status: 'error',
            reason: 'registry.npmjs.org returned 500',
        })
        expect(sink.item('pkg:npm/gone')).toEqual({key: 'pkg:npm/gone', purls: ['pkg:npm/gone'], status: 'not_found'})
        // Neither carries versions, so neither costs a version read.
        expect(store.versionKeys).toEqual([])
    })

    it('ends with the feeds in the trailer', async () => {
        const store = new FakeStore()
        store.feeds = [
            {
                type: 'npm',
                mode: 'feed',
                cursor: '31000004',
                cursor_time: new Date('2026-09-16T09:59:00Z'),
                last_run_at: new Date('2026-09-16T09:59:00Z'),
                last_ok_at: new Date('2026-09-16T09:59:00Z'),
                upstream_head_time: null,
                last_error: null,
                covered_since: new Date('2026-09-16T08:00:00Z'),
                lag_seconds: 42,
            },
        ]

        const sink = await resolve(ask([]), {store})

        expect(sink.lines).toEqual([
            {done: true, feeds: {npm: {mode: 'feed', lag_seconds: 42, cursor_time: '2026-09-16T09:59:00.000Z'}}},
        ])
    })

    it('reads versions 500 packages at a time, and hands each slice over as it comes', async () => {
        const store = new FakeStore()
        const purls: string[] = []
        for (let i = 0; i < 1200; i++) {
            const key = `pkg:npm/p${i}`
            purls.push(`${key}@1.0.0`)
            store.packages.set(key, packageRow({package_key: key, name: `p${i}`}))
            store.versions.set(key, [version('1.0.0', null)])
        }

        const sink = await resolve(ask(purls), {store})

        expect(store.versionKeys.map(keys => keys.length)).toEqual([500, 500, 200])
        // One batch — and so one flush — per slice, and the trailer.
        expect(sink.batches.map(batch => batch.length)).toEqual([500, 500, 200, 1])
        expect(new Set(sink.items.map(it => it.key)).size).toBe(1200)
    })

    it('does not wait when nothing is left open, however long the deadline', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        const clock = fakeClock()

        await resolve(ask(['pkg:npm/express'], {deadlineMs: 60_000}), {store, ...clock})

        expect(clock.elapsed()).toBe(0)
        expect(store.getPackagesCalls).toBe(1)
    })

    it('opens the sink only once the first read and the queue writes have succeeded', async () => {
        // Before `open` the route can still answer an HTTP 500; nothing may have been sent.
        const store = new FakeStore()
        store.createPending = async () => Promise.reject(new Error('deadlock detected'))
        const sink = new Collector()

        await expect(handleResolve(ask(['pkg:npm/brand-new']), {store}, sink)).rejects.toThrow(/deadlock/)
        expect(sink.opened).toBe(0)
        expect(sink.lines).toEqual([])
    })

    it('fails before opening when the very first look at the database fails', async () => {
        const store = new FakeStore()
        store.onGetPackages = () => {
            throw new Error('timeout exceeded when trying to connect')
        }
        const sink = new Collector()

        await expect(handleResolve(ask(['pkg:npm/brand-new']), {store}, sink)).rejects.toThrow(/timeout exceeded/)
        expect(sink.opened).toBe(0)
    })

    it('ends without a trailer when a read fails after the stream has opened', async () => {
        // The 200 has gone; all that is left is to stop short, which the caller reads as truncated.
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        store.onGetPackages = () => {
            if (store.getPackagesCalls > 1) throw new Error('timeout exceeded when trying to connect')
        }
        const sink = new Collector()
        const clock = fakeClock()

        await expect(
            handleResolve(ask(['pkg:npm/express', 'pkg:npm/brand-new'], {deadlineMs: 10_000}), {store, ...clock}, sink),
        ).rejects.toThrow(/timeout exceeded/)

        expect(sink.opened).toBe(1)
        expect(sink.items.map(it => it.key)).toEqual(['pkg:npm/express'])
        expect(sink.trailer).toBeUndefined()
        expect(store.feedCalls).toBe(0)
    })

    it('reports how the request went in one debug line', async () => {
        const store = new FakeStore()
        store.packages.set('pkg:npm/express', packageRow({package_key: 'pkg:npm/express'}))
        store.versions.set('pkg:npm/express', [version('1.0.0', null)])
        const debug: {msg: string; fields?: Record<string, unknown>}[] = []
        const log: Logger = {...nullLogger, debug: (msg, fields) => void debug.push({msg, fields}), child: () => log}

        await resolve(ask(['pkg:npm/express@1.0.0', 'pkg:npm/brand-new'], {deadlineMs: 4_000}), {
            store,
            log,
            ...fakeClock(),
            pollIntervalMs: 2_000,
        })

        expect(debug).toHaveLength(1)
        expect(debug[0]!.msg).toBe('resolve served')
        expect(debug[0]!.fields).toMatchObject({
            purls: 2,
            packages: 2,
            resolved: 1,
            pending: 1,
            reads: 2,
            wait_ms: 4_000,
            versions_ms: 0,
        })
    })
})
