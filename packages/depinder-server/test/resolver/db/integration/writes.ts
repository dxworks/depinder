import {beforeAll, describe, expect, it, vi} from 'vitest'
import {createResolveStore} from '../../../../src/resolver/api/store.js'
import type {Config} from '../../../../src/resolver/config.js'
import type {Db} from '../../../../src/resolver/db/db.js'
import {nullLogger, parsePurl} from '@depinder/core'
import {enqueue, PRIORITY} from '../../../../src/resolver/db/queue.js'
import type {FetchQueueRow, PackageRow} from '../../../../src/resolver/db/rows.js'
import {runOnce} from '../../../../src/resolver/worker/fill/pool.js'
import {sweepRetries} from '../../../../src/resolver/worker/fill/retry.js'
import {express, json, type Postgres} from '../db.integration.helpers.js'

/** Pending rows, the fill's writes and what the store reads back, the retry path. */
export function packageWriteTests(postgres: () => Postgres): void {
    describe('package writes', () => {
        let db: Db
        let config: Config

        beforeAll(() => {
            db = postgres().db
            config = postgres().config
        })

        /** Postgres counts deadlocks per database; the count not moving is the assertion. */
        async function deadlockCount(): Promise<string> {
            const row = await db.one<{deadlocks: string}>(
                'select deadlocks::text from pg_stat_database where datname = current_database()',
            )
            return row!.deadlocks
        }

        it('inserts unknown packages as pending and queues them', async () => {
            const store = createResolveStore(db)
            await store.createPending([parsePurl('pkg:npm/express@4.18.2'), parsePurl('pkg:npm/@babel/core')], null)
            // Same call twice must not explode on the primary key.
            await store.createPending([parsePurl('pkg:npm/express')], null)

            const rows = await store.getPackages(['pkg:npm/express', 'pkg:npm/@babel/core'])
            expect(rows).toHaveLength(2)
            expect(rows.every(r => r.status === 'pending' && r.tracked)).toBe(true)

            const queue = await db.query<FetchQueueRow>('select * from fetch_queue order by package_key')
            expect(queue.map(q => q.package_key)).toEqual(['pkg:npm/@babel/core', 'pkg:npm/express'])
            expect(queue[0]!.priority).toBe(PRIORITY.demand)
        })

        it('survives two chunks queueing overlapping packages at the same time', async () => {
            // The regression. Four chunks of a run arrive together and share packages, and against an
            // empty database every shared key is a brand-new row that `on conflict do nothing` holds
            // until its transaction ends. Insert them in each chunk's own order and two transactions
            // take the same two locks the opposite way round; Postgres breaks the cycle with 40P01 and
            // the losing chunk was an HTTP 500. `createPending` now sorts, so there is one lock order.
            const store = createResolveStore(db)
            const keys = Array.from({length: 400}, (_, i) => `pkg:npm/overlap-${String(i).padStart(4, '0')}`)
            const forward = keys.map(k => parsePurl(k))
            const backward = [...forward].reverse()

            const before = await deadlockCount()
            await Promise.all([store.createPending(forward, null), store.createPending(backward, null)])
            expect(await deadlockCount()).toBe(before)

            const rows = await store.getPackages(keys)
            expect(rows).toHaveLength(keys.length)
            const queued = await db.query<FetchQueueRow>(
                `select * from fetch_queue where package_key like 'pkg:npm/overlap-%'`,
            )
            expect(queued).toHaveLength(keys.length)

            await db.query(`delete from fetch_queue where package_key like 'pkg:npm/overlap-%'`)
            await db.query(`delete from package where package_key like 'pkg:npm/overlap-%'`)
        })

        it('fetches a queued package and writes package, versions and fetch_log in one go', async () => {
            vi.stubGlobal('fetch', (input: string) =>
                Promise.resolve(String(input).includes('express') ? json(express) : json({error: 'Not found'}, 404)),
            )

            const before = new Date()
            await runOnce({db, log: nullLogger, config})
            const after = new Date()

            const [pkg] = await db.query<PackageRow>('select * from package where package_key = $1', ['pkg:npm/express'])
            expect(pkg!.status).toBe('resolved')
            expect(pkg!.licenses).toEqual(['MIT'])
            expect(pkg!.latest_version).toBe('4.18.2')
            expect(pkg!.latest_prerelease_version).toBe('4.19.0')
            expect(pkg!.source).toBe('registry.npmjs.org')
            expect(pkg!.repo_url).toBe('https://github.com/expressjs/express')
            // Stamped when the fetch started, and nothing but the fetch vouches for it yet.
            expect(pkg!.fetched_at!.getTime()).toBeGreaterThanOrEqual(before.getTime())
            expect(pkg!.fetched_at!.getTime()).toBeLessThanOrEqual(after.getTime())
            expect(pkg!.as_of).toEqual(pkg!.fetched_at)

            const versions = await db.query<{version: string; licenses: string[]; prerelease: boolean}>(
                'select version, licenses, prerelease from package_version where package_key = $1 order by version',
                ['pkg:npm/express'],
            )
            expect(versions).toHaveLength(5)
            expect(versions.find(v => v.version === '5.0.0-alpha.8')!.prerelease).toBe(true)
            expect(versions.every(v => v.licenses.length === 1)).toBe(true)

            // The 404 package is stored as not_found with a retry a day out.
            const [missing] = await db.query<PackageRow>('select * from package where package_key = $1', [
                'pkg:npm/@babel/core',
            ])
            expect(missing!.status).toBe('not_found')
            expect(missing!.next_retry_at!.getTime()).toBeGreaterThan(Date.now())
            // "No such package" is a full answer from the registry of record.
            expect(missing!.fetched_at).toBeInstanceOf(Date)
            expect(missing!.as_of).toEqual(missing!.fetched_at)

            expect(await db.query('select 1 from fetch_queue')).toEqual([])
            const logs = await db.query<{package_key: string; http_status: number}>('select * from fetch_log')
            expect(logs).toHaveLength(2)
            expect(logs.map(l => l.http_status).sort()).toEqual([200, 404])
        })

        it('replaces a version list in place: new rows land, gone ones go, kept ones are refreshed', async () => {
            // The registry is the whole truth about a package: 0.14.0 has been unpublished, 4.18.3 is
            // new, and 4.17.1 now declares a different license. One statement does all three, so this
            // is where the upsert and the stale delete that ride together are actually run.
            const changed = structuredClone(express) as {
                versions: Record<string, {license?: string}>
                time: Record<string, string>
            }
            delete changed.versions['0.14.0']
            delete changed.time['0.14.0']
            changed.versions['4.18.3'] = {license: 'MIT'}
            changed.time['4.18.3'] = '2026-02-02T00:00:00Z'
            changed.versions['4.17.1'] = {license: 'Apache-2.0'}

            await enqueue(db, ['pkg:npm/express'], PRIORITY.demand)
            vi.stubGlobal('fetch', () => Promise.resolve(json(changed)))
            await runOnce({db, log: nullLogger, config})

            const versions = await db.query<{version: string; licenses: string[]}>(
                'select version, licenses from package_version where package_key = $1 order by version',
                ['pkg:npm/express'],
            )
            expect(versions.map(v => v.version)).toEqual(['4.17.1', '4.18.2', '4.18.3', '4.19.0', '5.0.0-alpha.8'])
            expect(versions.find(v => v.version === '4.17.1')!.licenses).toEqual(['Apache-2.0'])
            expect(await db.query('select 1 from fetch_queue')).toEqual([])
        })

        it('serves what it stored through the resolve store', async () => {
            const store = createResolveStore(db)
            const rows = await store.getVersions(['pkg:npm/express'])

            // One row per package, not one per version, and the aggregate is ordered by release date.
            expect(rows).toHaveLength(1)
            const versions = rows[0]!.versions
            expect(versions.map(v => v[0])).toEqual(['4.17.1', '5.0.0-alpha.8', '4.18.2', '4.19.0', '4.18.3'])
            // Only a version whose licenses differ from the package's ['MIT'] carries its own list.
            expect(versions[0]).toEqual([
                '4.17.1',
                Math.floor(Date.parse('2019-05-25T16:32:32.590Z') / 1000),
                0,
                ['Apache-2.0'],
            ])
            expect(versions.find(v => v[0] === '4.18.2')).toEqual([
                '4.18.2',
                Math.floor(Date.parse('2022-10-08T20:46:50.089Z') / 1000),
                0,
            ])
            // Bit 0 of the flags is the prerelease bit.
            expect(versions.find(v => v[0] === '5.0.0-alpha.8')![2]).toBe(1)

            const feeds = await store.getFeeds()
            expect(feeds).toEqual([])
        })

        it('reports a version with no release date as a null, not as an epoch', async () => {
            await db.query(
                `insert into package_version (purl, package_key, version, released_at, licenses, yanked)
                 values ('pkg:npm/express@0.0.1', 'pkg:npm/express', '0.0.1', null, '{}', true)`,
            )
            const rows = await createResolveStore(db).getVersions(['pkg:npm/express'])

            // Nulls sort first, and bit 1 of the flags is the yanked bit.
            expect(rows[0]!.versions[0]).toEqual(['0.0.1', null, 2, []])
            await db.query(`delete from package_version where purl = 'pkg:npm/express@0.0.1'`)
        })

        it('backs off, then gives up after three attempts without losing good data', async () => {
            vi.stubGlobal('fetch', () => Promise.resolve(json({error: 'boom'}, 500)))
            const [good] = await db.query<PackageRow>('select * from package where package_key = $1', ['pkg:npm/express'])
            await enqueue(db, ['pkg:npm/express'], PRIORITY.demand)

            for (let attempt = 1; attempt <= 3; attempt++) {
                await runOnce({db, log: nullLogger, config})
                // Undo the backoff so the next tick picks the row up again.
                await db.query('update fetch_queue set next_attempt_at = now()')
            }

            const [pkg] = await db.query<PackageRow>('select * from package where package_key = $1', ['pkg:npm/express'])
            // Already resolved, so the failure is recorded but the facts keep being served.
            expect(pkg!.status).toBe('resolved')
            expect(pkg!.error).toMatch(/500/)
            expect(pkg!.next_retry_at).toBeInstanceOf(Date)
            // Nothing was fetched, so neither timestamp moves: they still describe the last good fetch.
            expect(pkg!.fetched_at).toEqual(good!.fetched_at)
            expect(pkg!.as_of).toEqual(good!.as_of)
            expect(await db.query('select 1 from fetch_queue')).toEqual([])
        })

        it('re-queues packages whose retry has come due', async () => {
            await db.query("update package set next_retry_at = now() - interval '1 minute'")
            await sweepRetries(db, nullLogger)

            const queue = await db.query<FetchQueueRow>('select * from fetch_queue order by package_key')
            expect(queue.map(q => q.package_key)).toEqual(['pkg:npm/@babel/core', 'pkg:npm/express'])
            expect(queue[0]!.priority).toBe(PRIORITY.retry)
            expect(await db.query('select 1 from package where next_retry_at is not null')).toEqual([])
            await db.query('delete from fetch_queue')
        })
    })
}
