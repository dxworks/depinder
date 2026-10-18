import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {handleResolve} from '../../../../src/resolver/api/resolve/handle.js'
import {createResolveStore} from '../../../../src/resolver/api/store.js'
import type {Config} from '../../../../src/resolver/config.js'
import type {Db} from '../../../../src/resolver/db/db.js'
import {nullLogger, type ResolveItem, type ResolveLine} from '@depinder/core'
import {enqueueFeedEvents, PRIORITY} from '../../../../src/resolver/db/queue.js'
import type {FetchQueueRow} from '../../../../src/resolver/db/rows.js'
import {runOnce} from '../../../../src/resolver/worker/fill/pool.js'
import {MAX_ATTEMPTS} from '../../../../src/resolver/worker/fill/retry.js'
import {ensureFeedRows} from '../../../../src/resolver/worker/feeds.js'
import {express, json, type Postgres} from '../db.integration.helpers.js'

/** A queue row as these tests look at it: with its schedule measured against Postgres's clock. */
type QueueState = FetchQueueRow & {due_in_s: number; recheck_in_s: number | null}

/** The second look after a feed-triggered fetch: scheduled, answered, pulled forward, dropped. */
export function recheckTests(postgres: () => Postgres): void {
    describe('second look after a feed-triggered fetch', () => {
        const KEY = 'pkg:npm/rc-news'
        let db: Db
        let config: Config
        let fetches = 0

        beforeAll(() => {
            db = postgres().db
            config = postgres().config
        })

        beforeEach(async () => {
            await db.query(`delete from fetch_queue`)
            await db.query(`delete from package where package_key like 'pkg:npm/rc-%'`)
            // A live npm feed whose cursor is a minute ahead, so its vouching shows in confirmed_at.
            await ensureFeedRows(db)
            await db.query(
                `update registry_feed
                 set cursor = 'c', cursor_time = now() + interval '1 minute',
                     covered_since = now() - interval '1 hour', last_error = null
                 where type = 'npm'`,
            )
            fetches = 0
            vi.stubGlobal('fetch', async () => {
                fetches++
                return json({...(express as object), name: 'rc-news'})
            })
        })

        const queueRow = async (): Promise<QueueState | undefined> =>
            (await db.query<QueueState>(
                `select *,
                        extract(epoch from next_attempt_at - now())::float8 as due_in_s,
                        extract(epoch from recheck_at - now())::float8      as recheck_in_s
                 from fetch_queue where package_key = $1`,
                [KEY],
            ))[0]

        /** The settle time passing: the second look is due now. */
        const settleTimePasses = (): Promise<unknown> =>
            db.query(`update fetch_queue set next_attempt_at = now() - interval '1 second',
                                             recheck_at      = now() - interval '1 second'`)

        const fetchedAt = async (): Promise<Date> =>
            (await db.one<{fetched_at: Date}>('select fetched_at from package where package_key = $1', [KEY]))!.fetched_at

        it('follows a feed-triggered fetch with one second look, and that look schedules no third', async () => {
            await enqueueFeedEvents(db, [KEY])
            await runOnce({db, log: nullLogger, config})
            expect(fetches).toBe(1)

            const pending = (await queueRow())!
            expect(pending).toMatchObject({feed_event: false, priority: PRIORITY.recheck, attempts: 0, leased: false,
                wanted_until: null, requests: 1})
            // npm's settle time, six minutes, from the write; the row waits for exactly that.
            expect(pending.recheck_in_s).toBeGreaterThan(355)
            expect(pending.recheck_in_s).toBeLessThanOrEqual(360)
            expect(pending.next_attempt_at).toEqual(pending.recheck_at)

            // Meanwhile the feed does not vouch for the facts the first fetch may have got from a cache.
            const store = createResolveStore(db)
            const [meanwhile] = await store.getPackages([KEY])
            expect(meanwhile).toMatchObject({queued: true, confirmed_at: meanwhile!.as_of})

            // Not due yet: nothing is fetched.
            await runOnce({db, log: nullLogger, config})
            expect(fetches).toBe(1)

            await settleTimePasses()
            await runOnce({db, log: nullLogger, config})
            expect(fetches).toBe(2)
            expect(await queueRow()).toBeUndefined()

            const [after] = await store.getPackages([KEY])
            expect(after!.queued).toBe(false)
            expect(after!.confirmed_at!.getTime()).toBeGreaterThan(after!.as_of!.getTime())
        })

        it('looks once more when a new feed event arrives while the second look is pending', async () => {
            await enqueueFeedEvents(db, [KEY])
            await runOnce({db, log: nullLogger, config})
            const scheduled = (await queueRow())!

            await enqueueFeedEvents(db, [KEY])
            const merged = (await queueRow())!
            // The schedule stands; the event is remembered for the look to act on.
            expect(merged).toMatchObject({feed_event: true, requests: 2, priority: PRIORITY.feed})
            expect(merged.next_attempt_at).toEqual(scheduled.next_attempt_at)

            await settleTimePasses()
            await runOnce({db, log: nullLogger, config})
            const again = (await queueRow())!
            expect(again).toMatchObject({feed_event: false, priority: PRIORITY.recheck})
            expect(again.recheck_in_s).toBeGreaterThan(355)

            await settleTimePasses()
            await runOnce({db, log: nullLogger, config})
            expect(fetches).toBe(3)
            expect(await queueRow()).toBeUndefined()
        })

        it('lets a request that needs a fresh fetch jump the second look, then waits for the look again', async () => {
            await enqueueFeedEvents(db, [KEY])
            await runOnce({db, log: nullLogger, config})
            const scheduled = (await queueRow())!
            const first = await fetchedAt()

            const until = new Date(Date.now() + 30_000)
            await createResolveStore(db).queueRefresh([KEY], until)
            const jumped = (await queueRow())!
            expect(jumped.due_in_s).toBeLessThanOrEqual(0)
            expect(jumped).toMatchObject({requests: 1, recheck_at: scheduled.recheck_at})
            expect(jumped.wanted_until!.getTime()).toBe(until.getTime())

            await runOnce({db, log: nullLogger, config})
            expect((await fetchedAt()).getTime()).toBeGreaterThan(first.getTime())
            const resumed = (await queueRow())!
            expect(resumed).toMatchObject({recheck_at: scheduled.recheck_at, next_attempt_at: scheduled.recheck_at,
                wanted_until: null, leased: false})

            await settleTimePasses()
            await runOnce({db, log: nullLogger, config})
            expect(fetches).toBe(3)
            expect(await queueRow()).toBeUndefined()
        })

        it('leaves a backoff alone when a request asks again', async () => {
            await enqueueFeedEvents(db, [KEY])
            await runOnce({db, log: nullLogger, config})
            await db.query(`update fetch_queue set attempts = 1, next_attempt_at = now() + interval '30 seconds'`)

            await createResolveStore(db).queueRefresh([KEY], null)
            expect((await queueRow())!.due_in_s).toBeGreaterThan(20)
        })

        it('answers /resolve at once from a fresh row whose second look is pending, and fetches a stale one now', async () => {
            await enqueueFeedEvents(db, [KEY])
            await runOnce({db, log: nullLogger, config})
            const store = createResolveStore(db)
            const resolve = async (maxAgeS: number): Promise<{items: ResolveItem[]; ms: number}> => {
                const lines: ResolveLine[] = []
                const startedAt = Date.now()
                await handleResolve({purls: [`${KEY}@4.18.2`], deadlineMs: 300, maxAgeS}, {store}, {
                    open: () => undefined,
                    emit: async batch => void lines.push(...batch),
                })
                return {items: lines.filter((l): l is ResolveItem => 'status' in l), ms: Date.now() - startedAt}
            }

            // Fresh for a day's max age: answered from what was stored, without waiting on the queue.
            const fresh = await resolve(86_400)
            expect(fresh.items.map(i => i.status)).toEqual(['resolved'])
            expect(fresh.ms).toBeLessThan(300)
            expect((await queueRow())!.due_in_s).toBeGreaterThan(300)

            // Stale for `max_age: 0`: no worker runs here, so it goes out `refreshing` at the deadline,
            // but the fetch it asked for is due now rather than at the second look.
            const stale = await resolve(0)
            expect(stale.items.map(i => i.status)).toEqual(['refreshing'])
            expect((await queueRow())!.due_in_s).toBeLessThanOrEqual(0)
        })

        it('owes no second look after giving up on a feed-triggered fetch', async () => {
            await enqueueFeedEvents(db, [KEY])
            await db.query(`update fetch_queue set attempts = $1`, [MAX_ATTEMPTS - 1])
            vi.stubGlobal('fetch', async () => json({error: 'down'}, 500))

            await runOnce({db, log: nullLogger, config})
            expect(await queueRow()).toBeUndefined()
        })
    })
}
