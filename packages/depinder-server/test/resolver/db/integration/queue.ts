import {beforeAll, describe, expect, it, vi} from 'vitest'
import pg from 'pg'
import {createResolveStore} from '../../../../src/resolver/api/store.js'
import type {Config} from '../../../../src/resolver/config.js'
import type {Db} from '../../../../src/resolver/db/db.js'
import {sleep} from '../../../../src/resolver/registries/http.js'
import {nullLogger} from '../../../../src/shared/log.js'
import {parsePurl} from '../../../../src/shared/purl.js'
import {enqueue, PRIORITY} from '../../../../src/resolver/db/queue.js'
import type {FetchQueueRow, PackageRow} from '../../../../src/resolver/db/rows.js'
import {dequeue, quotas, renewLeases} from '../../../../src/resolver/worker/fill/dequeue.js'
import {runOnce} from '../../../../src/resolver/worker/fill/pool.js'
import {express, json, url, type Postgres} from '../db.integration.helpers.js'

/** What the queue keeps, the order it hands rows out in, who it wants them for, and the leases. */
export function queueTests(postgres: () => Postgres): void {
    describe('queue and leases', () => {
        let db: Db
        let config: Config

        beforeAll(() => {
            db = postgres().db
            config = postgres().config
        })

        it('keeps the queue row of a package asked for again while it was being fetched', async () => {
            // A feed event for a package the worker already has in hand: the fetch may have been too
            // early to see the change, so the row must survive the write and come round again.
            await db.query('delete from fetch_queue')
            await enqueue(db, ['pkg:npm/midfetch'], PRIORITY.demand)
            vi.stubGlobal('fetch', async () => {
                await enqueue(db, ['pkg:npm/midfetch'], PRIORITY.feed)
                return json({...(express as object), name: 'midfetch'})
            })

            await runOnce({db, log: nullLogger, config})

            const [pkg] = await db.query<PackageRow>('select * from package where package_key = $1', ['pkg:npm/midfetch'])
            expect(pkg!.status).toBe('resolved')
            const queue = await db.query<FetchQueueRow>('select * from fetch_queue')
            expect(queue.map(q => q.package_key)).toEqual(['pkg:npm/midfetch'])
            expect(queue[0]!.requests).toBe(2)
            expect(queue[0]!.attempts).toBe(0)
            // Due now, not at the end of the lease the dequeue gave it. Asked of Postgres's
            // clock, which need not agree with this one.
            const [due] = await db.query<{due: boolean}>('select next_attempt_at <= now() as due from fetch_queue')
            expect(due!.due).toBe(true)

            // The second fetch is asked for by nobody else, so it takes the row with it.
            vi.stubGlobal('fetch', async () => json({...(express as object), name: 'midfetch'}))
            await runOnce({db, log: nullLogger, config})
            expect(await db.query('select 1 from fetch_queue')).toEqual([])

            await db.query("delete from package where package_key = 'pkg:npm/midfetch'")
        })

        it('dequeues by priority within each ecosystem\'s free slots', async () => {
            await db.query('delete from fetch_queue')
            const crates = Array.from({length: 30}, (_, i) => `pkg:cargo/c${String(i).padStart(2, '0')}`)
            await enqueue(db, crates, PRIORITY.demand)
            await enqueue(db, ['pkg:npm/a', 'pkg:npm/b', 'pkg:npm/c'], PRIORITY.feed)

            const [typed] = await db.query<{type: string}>(`select type from fetch_queue where package_key = 'pkg:cargo/c00'`)
            expect(typed!.type).toBe('cargo')

            // Three slots: cargo outranks npm, but only two crates may be in flight.
            const first = await dequeue(db, 3, quotas(new Map()))
            expect(first.map(r => r.package_key).sort()).toEqual(['pkg:cargo/c00', 'pkg:cargo/c01', 'pkg:npm/a'])
            expect(first.every(r => r.leased)).toBe(true)

            // With cargo at its cap, the rest of the npm comes next and no crate does.
            const second = await dequeue(db, 10, quotas(new Map([['cargo', 2], ['npm', 1]])))
            expect(second.map(r => r.package_key).sort()).toEqual(['pkg:npm/b', 'pkg:npm/c'])

            const [counts] = await db.query<{leased: number; due: number}>(
                `select count(*) filter (where leased)::int as leased,
                        count(*) filter (where next_attempt_at <= now())::int as due
                 from fetch_queue`,
            )
            expect(counts).toEqual({leased: 5, due: 28})

            // What GET /queue reads, from the same state.
            const stats = await createResolveStore(db).getQueue()
            expect(stats.groups).toEqual([
                {type: 'cargo', priority: PRIORITY.demand, queued: 30, urgent: 0, in_flight: 2, due: 28, retrying: 0,
                    oldest_due_s: expect.any(Number) as number},
                {type: 'npm', priority: PRIORITY.feed, queued: 3, urgent: 0, in_flight: 3, due: 0, retrying: 0, oldest_due_s: 0},
            ])
            expect(typeof stats.errors).toBe('number')
            await db.query('delete from fetch_queue')
        })

        it('dequeues what somebody waits for first, soonest deadline first, and forgets a deadline once it passed', async () => {
            await db.query('delete from fetch_queue')
            const inSeconds = (s: number): Date => new Date(Date.now() + s * 1000)
            // Oldest first: the expired ask, then news nobody waits for, then two waiting callers.
            await enqueue(db, ['pkg:npm/expired'], PRIORITY.demand, inSeconds(-10))
            await enqueue(db, ['pkg:npm/news'], PRIORITY.feed)
            await enqueue(db, ['pkg:npm/retrying'], PRIORITY.retry)
            await enqueue(db, ['pkg:npm/retrying'], PRIORITY.retry, inSeconds(60))
            await enqueue(db, ['pkg:npm/soonest'], PRIORITY.demand, inSeconds(30))
            // A feed event for a package somebody waits for leaves the deadline alone.
            await enqueue(db, ['pkg:npm/soonest'], PRIORITY.feed)

            // Two callers are still waiting; the expired ask no longer counts.
            const stats = await createResolveStore(db).getQueue()
            expect(stats.groups.reduce((sum, g) => sum + g.urgent, 0)).toBe(2)

            const order: string[] = []
            for (let i = 0; i < 4; i++) {
                const [row] = await dequeue(db, 1, quotas(new Map()))
                order.push(row!.package_key)
            }
            // Waiting callers first, by deadline — a retry included; then priority and age.
            expect(order).toEqual(['pkg:npm/soonest', 'pkg:npm/retrying', 'pkg:npm/expired', 'pkg:npm/news'])
            await db.query('delete from fetch_queue')
        })

        it('marks rows wanted with the later deadline, and tells only a worker that holds one', async () => {
            await db.query('delete from fetch_queue')
            const store = createResolveStore(db)
            const listener = new pg.Client({connectionString: url})
            await listener.connect()
            const heard: string[] = []
            listener.on('notification', m => {
                if (m.channel === 'package_wanted') heard.push(m.payload!)
            })
            await listener.query('listen package_wanted')
            try {
                const soon = new Date(Date.now() + 10_000)
                const later = new Date(Date.now() + 20_000)
                await enqueue(db, ['pkg:npm/held', 'pkg:npm/waiting'], PRIORITY.feed)
                await dequeue(db, 1, quotas(new Map()))                     // a worker now holds `held`
                await db.query(`update fetch_queue set next_attempt_at = now() + interval '1 minute'
                                where package_key = 'pkg:npm/waiting'`)     // and `waiting` is in backoff

                await store.markWanted(['pkg:npm/waiting', 'pkg:npm/held'], later)
                await store.markWanted(['pkg:npm/held'], soon)               // an earlier deadline does not win
                await store.queueRefresh(['pkg:npm/waiting'], soon)          // nor does a refresh's

                const rows = await db.query<FetchQueueRow & {backoff: boolean}>(
                    `select *, next_attempt_at > now() + interval '30 seconds' as backoff
                     from fetch_queue order by package_key`,
                )
                expect(rows.map(r => [r.package_key, r.wanted_until?.getTime(), r.requests])).toEqual([
                    ['pkg:npm/held', later.getTime(), 1],
                    ['pkg:npm/waiting', later.getTime(), 1],
                ])
                expect(rows.find(r => r.package_key === 'pkg:npm/waiting')!.backoff).toBe(true)

                const deadline = Date.now() + 2_000
                while (heard.length < 2 && Date.now() < deadline) await sleep(10)
                expect(heard).toEqual([`pkg:npm/held ${later.getTime()}`, `pkg:npm/held ${soon.getTime()}`])
            } finally {
                await listener.end()
                await db.query('delete from fetch_queue')
            }
        })

        it('wants a package another request created a moment earlier', async () => {
            await db.query('delete from fetch_queue')
            await db.query("delete from package where package_key = 'pkg:npm/raced'")
            const store = createResolveStore(db)
            const until = new Date(Date.now() + 30_000)
            await store.createPending([parsePurl('pkg:npm/raced')], null)   // the other request, no deadline
            await store.createPending([parsePurl('pkg:npm/raced')], until)  // this one: created nothing
            const [row] = await db.query<FetchQueueRow>(`select * from fetch_queue where package_key = 'pkg:npm/raced'`)
            expect(row!.wanted_until!.getTime()).toBe(until.getTime())
            expect(row!.requests).toBe(1)
            await db.query("delete from package where package_key = 'pkg:npm/raced'")
            await db.query('delete from fetch_queue')
        })

        it('renews only leases still held, and takes back a lease that ran out', async () => {
            await db.query('delete from fetch_queue')
            await enqueue(db, ['pkg:npm/held', 'pkg:npm/settled'], PRIORITY.demand)
            expect(await dequeue(db, 10, quotas(new Map()))).toHaveLength(2)

            // `settled` was asked for again mid-fetch, so its write kept the row and made it due now —
            // the heartbeat that lands after that must leave it due.
            await db.query(
                `update fetch_queue set next_attempt_at = now(), leased = false where package_key = 'pkg:npm/settled'`,
            )
            await db.query(`update fetch_queue set next_attempt_at = now() + interval '1 second'`
                + ` where package_key = 'pkg:npm/held'`)
            await renewLeases(db, ['pkg:npm/held', 'pkg:npm/settled'])

            const rows = await db.query<{package_key: string; left_s: number}>(
                `select package_key, extract(epoch from next_attempt_at - now())::int as left_s
                 from fetch_queue order by package_key`,
            )
            expect(rows.find(r => r.package_key === 'pkg:npm/held')!.left_s).toBeGreaterThan(100)
            expect(rows.find(r => r.package_key === 'pkg:npm/settled')!.left_s).toBeLessThanOrEqual(0)

            // A worker that died stops renewing: once the lease is behind us, the row is anyone's.
            await db.query(`update fetch_queue set next_attempt_at = now() - interval '1 second'`
                + ` where package_key = 'pkg:npm/held'`)
            const taken = await dequeue(db, 10, quotas(new Map()))
            expect(taken.map(r => r.package_key).sort()).toEqual(['pkg:npm/held', 'pkg:npm/settled'])
            await db.query('delete from fetch_queue')
        })
    })
}
