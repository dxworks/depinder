import {beforeAll, describe, expect, it, vi} from 'vitest'
import {createResolveStore} from '../../../../src/resolver/api/store.js'
import type {Config} from '../../../../src/resolver/config.js'
import type {Db} from '../../../../src/resolver/db/db.js'
import {createResolverEvents} from '../../../../src/resolver/events.js'
import {setTimeout as sleep} from 'node:timers/promises'
import {nullLogger, parsePurl} from '@depinder/core'
import {startNotifyBridge} from '../../../../src/resolver/db/notify.js'
import {enqueue, PRIORITY} from '../../../../src/resolver/db/queue.js'
import type {FetchQueueRow, PackageRow} from '../../../../src/resolver/db/rows.js'
import {runOnce} from '../../../../src/resolver/worker/fill/pool.js'
import {sweepRetries} from '../../../../src/resolver/worker/fill/retry.js'
import {ensureFeedRows} from '../../../../src/resolver/worker/feeds.js'
import {express, json, type Postgres} from '../db.integration.helpers.js'

/** What another process hears, how `confirmed_at` is worked out, and a re-check a registry asked for. */
export function freshnessTests(postgres: () => Postgres): void {
    describe('notify and freshness', () => {
        let db: Db
        let config: Config

        beforeAll(() => {
            db = postgres().db
            config = postgres().config
        })

        it('notifies another process of committed work and settled packages, and of nothing rolled back', async () => {
            await db.query('delete from fetch_queue')
            const events = createResolverEvents()
            let queued = 0
            const settled: string[] = []
            events.onQueued(() => queued++)
            events.onSettled(key => settled.push(key))
            const bridge = startNotifyBridge({config, events, log: nullLogger})
            try {
                const deadline = Date.now() + 5_000
                while (bridge.status !== 'connected' && Date.now() < deadline) await sleep(10)
                expect(bridge.status).toBe('connected')

                // Rolled back: the notification goes with the transaction.
                await db
                    .withTransaction(async tx => {
                        await enqueue(tx, ['pkg:npm/never'], PRIORITY.demand)
                        throw new Error('roll back')
                    })
                    .catch(() => undefined)
                await sleep(100)
                expect(queued).toBe(0)

                // No in-process events are wired here: whatever arrives came through Postgres.
                await createResolveStore(db).createPending([parsePurl('pkg:npm/notified')], null)
                await waitUntil(() => queued > 0)
                expect(queued).toBe(1)

                vi.stubGlobal('fetch', async () => json({...(express as object), name: 'notified'}))
                await runOnce({db, log: nullLogger, config})
                await waitUntil(() => settled.length > 0)
                expect(settled).toEqual(['pkg:npm/notified'])
            } finally {
                await bridge.stop()
                await db.query("delete from package where package_key = 'pkg:npm/notified'")
                await db.query('delete from fetch_queue')
            }

            async function waitUntil(condition: () => boolean): Promise<void> {
                const deadline = Date.now() + 5_000
                while (!condition() && Date.now() < deadline) await sleep(10)
            }
        })

        it('works out confirmed_at: the feed vouches only when it can be believed', async () => {
            const store = createResolveStore(db)
            await ensureFeedRows(db)
            const covered = new Date('2026-10-01T08:00:00Z')
            const cursor = new Date('2026-10-01T11:59:00Z')
            await db.query(
                `update registry_feed set cursor = 'c', cursor_time = $1, covered_since = $2 where type in ('npm', 'maven')`,
                [cursor, covered],
            )

            const fetched = new Date('2026-10-01T09:00:00Z')
            const before = new Date('2026-10-01T07:00:00Z')
            const rows: [key: string, type: string, fetchedAt: Date | null, tracked: boolean, error: string | null][] = [
                ['pkg:npm/cf-vouched', 'npm', fetched, true, null],
                ['pkg:npm/cf-untracked', 'npm', fetched, false, null],
                ['pkg:npm/cf-failed', 'npm', fetched, true, 'registry.npmjs.org returned 503'],
                ['pkg:npm/cf-queued', 'npm', fetched, true, null],
                ['pkg:npm/cf-before', 'npm', before, true, null],
                ['pkg:npm/cf-never', 'npm', null, true, null],
                ['pkg:maven/g/cf-polled', 'maven', fetched, true, null],
            ]
            for (const [key, type, fetchedAt, tracked, error] of rows) {
                await db.query(
                    `insert into package (package_key, type, name, status, fetched_at, as_of, tracked, error)
                     values ($1, $2, $1, 'resolved', $3, $3, $4, $5)`,
                    [key, type, fetchedAt, tracked, error],
                )
            }
            await enqueue(db, ['pkg:npm/cf-queued'], PRIORITY.feed)

            const got = new Map((await store.getPackages(rows.map(r => r[0]))).map(r => [r.package_key, r]))
            expect(got.size).toBe(rows.length)
            // Fetched while the feed was running, and nothing since: the feed vouches up to its cursor.
            expect(got.get('pkg:npm/cf-vouched')).toMatchObject({confirmed_at: cursor, queued: false})
            // Any one condition missing, and the package is only as fresh as its own as_of.
            expect(got.get('pkg:npm/cf-untracked')!.confirmed_at).toEqual(fetched)
            expect(got.get('pkg:npm/cf-failed')!.confirmed_at).toEqual(fetched)
            expect(got.get('pkg:npm/cf-queued')).toMatchObject({confirmed_at: fetched, queued: true})
            expect(got.get('pkg:npm/cf-before')!.confirmed_at).toEqual(before)
            expect(got.get('pkg:npm/cf-never')!.confirmed_at).toBeNull()
            // Poll mode: the cursor says nothing about a package; its 304s are already in as_of.
            expect(got.get('pkg:maven/g/cf-polled')!.confirmed_at).toEqual(fetched)

            // A refresh leaves a row already queued exactly as it was, and queues the rest below demand.
            await store.queueRefresh(['pkg:npm/cf-queued', 'pkg:npm/cf-before'], null)
            const queue = new Map(
                (await db.query<FetchQueueRow>(`select * from fetch_queue where package_key like 'pkg:npm/cf-%'`)).map(q => [
                    q.package_key,
                    q,
                ]),
            )
            expect(queue.get('pkg:npm/cf-queued')).toMatchObject({priority: PRIORITY.feed, requests: 1})
            expect(queue.get('pkg:npm/cf-before')).toMatchObject({priority: PRIORITY.refresh, requests: 1})

            await db.query(`delete from fetch_queue where package_key like '%/cf-%'`)
            await db.query(`delete from package where package_key like '%/cf-%'`)
        })

        it('stores a golang re-check the registry asked for, and the sweeper re-queues it when due', async () => {
            // A module whose only version is an hour old, which deps.dev has not scanned yet.
            const released = new Date(Date.now() - 3_600_000).toISOString()
            vi.stubGlobal('fetch', (input: string) => {
                const url = String(input)
                if (url.endsWith('/@v/list')) return Promise.resolve(new Response('v1.0.0\n', {status: 200}))
                if (url.endsWith('/@latest')) return Promise.resolve(json({Version: 'v1.0.0', Time: released}))
                if (url.endsWith('.info')) return Promise.resolve(json({Version: 'v1.0.0', Time: released}))
                return Promise.resolve(json({code: 'NOT_FOUND'}, 404)) // api.deps.dev
            })
            await enqueue(db, ['pkg:golang/example.com/recheck'], PRIORITY.demand)

            const before = Date.now()
            await runOnce({db, log: nullLogger, config})

            const row = async (): Promise<PackageRow> =>
                (await db.query<PackageRow>('select * from package where package_key = $1', ['pkg:golang/example.com/recheck']))[0]!
            const written = await row()
            expect(written.status).toBe('resolved')
            expect(written.next_retry_at!.getTime()).toBeGreaterThanOrEqual(before + 6 * 3_600_000 - 1_000)
            expect(await db.query(`select 1 from fetch_queue where package_key = 'pkg:golang/example.com/recheck'`)).toEqual([])

            // Six hours on: the sweeper puts it back in the queue and leaves its facts served.
            await db.query(
                `update package set next_retry_at = now() - interval '1 minute' where package_key = 'pkg:golang/example.com/recheck'`,
            )
            await sweepRetries(db, nullLogger)

            const [queued] = await db.query<FetchQueueRow>(
                `select * from fetch_queue where package_key = 'pkg:golang/example.com/recheck'`,
            )
            expect(queued!.priority).toBe(PRIORITY.retry)
            expect(await row()).toMatchObject({status: 'resolved', next_retry_at: null})

            await db.query(`delete from fetch_queue where package_key = 'pkg:golang/example.com/recheck'`)
            await db.query(`delete from package where package_key = 'pkg:golang/example.com/recheck'`)
        })
    })
}
