import {afterEach, describe, expect, it, vi} from 'vitest'
import {createResolveStore, FEEDS_TTL_MS} from '../../../src/resolver/api/store.js'
import {DEADLOCK_DETECTED, type Db, type Queryable} from '../../../src/resolver/db/db.js'
import {parsePurl} from '@depinder/core'
import {PRIORITY} from '../../../src/resolver/db/queue.js'

/**
 * The SQL in the store can only be run by `db.integration.test.ts`. What is testable here is what
 * the store does around it: the feed memo, the two queries it does not make at all when there is
 * nothing to ask about, and what `createPending` hands its statements — which is the order two
 * concurrent chunks take row locks in.
 */

/** A `Db` that answers everything with one row and counts the statements it was given. */
function countingDb(): {db: Db; texts: string[]} {
    const texts: string[] = []
    const query = async (text: string): Promise<Record<string, unknown>[]> => {
        texts.push(text)
        return [{type: 'npm'}]
    }
    return {db: {query} as unknown as Db, texts}
}

interface Call {
    text: string
    params: readonly unknown[]
}

/**
 * A `Db` whose `withTransaction` records every statement of every attempt. `fail` is consulted once
 * per transaction and is how a deadlock victim is staged.
 */
function transactionDb(fail: (attempt: number) => unknown = () => undefined): {
    db: Db
    attempts: Call[][]
} {
    const attempts: Call[][] = []
    const db = {
        async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
            const calls: Call[] = []
            attempts.push(calls)
            const tx: Queryable = {
                async query(text: string, params: readonly unknown[] = []) {
                    calls.push({text, params})
                    // Every package is new to this database, so the insert creates all of them.
                    if (text.includes('returning package_key')) {
                        return (params[0] as string[]).map(package_key => ({package_key}))
                    }
                    return []
                },
            } as Queryable
            const result = await fn(tx)
            const thrown = fail(attempts.length)
            if (thrown) throw thrown
            return result
        },
    } as unknown as Db
    return {db, attempts}
}

function pgError(code: string): Error & {code: string} {
    return Object.assign(new Error(`${code} happened`), {code})
}

afterEach(() => {
    vi.useRealTimers()
})

describe('getFeeds', () => {
    it('reads the feed rows once for a burst of requests, then again once they are stale', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-09-17T12:00:00Z'))
        const {db, texts} = countingDb()
        const store = createResolveStore(db)

        // Six chunks arriving together are six calls and one query.
        const first = await Promise.all(Array.from({length: 6}, () => store.getFeeds()))
        expect(texts).toHaveLength(1)
        expect(first[0]).toEqual([{type: 'npm'}])

        vi.setSystemTime(new Date(Date.now() + FEEDS_TTL_MS - 1))
        await store.getFeeds()
        expect(texts).toHaveLength(1)

        vi.setSystemTime(new Date(Date.now() + 1))
        await store.getFeeds()
        expect(texts).toHaveLength(2)
    })

    it('does not hold on to a failure', async () => {
        vi.useFakeTimers()
        let calls = 0
        const db = {
            query: async () => {
                calls++
                if (calls === 1) throw new Error('connection terminated')
                return [{type: 'npm'}]
            },
        } as unknown as Db
        const store = createResolveStore(db)

        await expect(store.getFeeds()).rejects.toThrow(/connection terminated/)
        // The next caller retries rather than being handed the same failure for five seconds.
        expect(await store.getFeeds()).toEqual([{type: 'npm'}])
        expect(calls).toBe(2)
    })
})

describe('an empty ask', () => {
    it('costs no query at all', async () => {
        const {db, texts} = countingDb()
        const store = createResolveStore(db)

        expect(await store.getPackages([])).toEqual([])
        expect(await store.getVersions([])).toEqual([])
        await store.createPending([], null)
        await store.queueRefresh([], null)
        expect(texts).toEqual([])
    })
})

describe('createPending', () => {
    const purls = ['pkg:npm/react', 'pkg:npm/express', 'pkg:npm/lodash'].map(p => parsePurl(p))
    const sorted = ['pkg:npm/express', 'pkg:npm/lodash', 'pkg:npm/react']

    it('inserts packages and queue rows in key order, whatever order the purls arrived in', async () => {
        // Two chunks of one run carrying the same packages in opposite orders: the thing that used
        // to deadlock, because `on conflict do nothing` holds each new row until the commit.
        const forward = transactionDb()
        const backward = transactionDb()

        await createResolveStore(forward.db).createPending(purls, null)
        await createResolveStore(backward.db).createPending([...purls].reverse(), null)

        for (const {attempts} of [forward, backward]) {
            const [insertPackages, insertQueue] = attempts[0]!
            expect(insertPackages!.text).toMatch(/insert into package/)
            expect(insertPackages!.params[0]).toEqual(sorted)
            // The names travel in their own array and must stay aligned with the keys.
            expect(insertPackages!.params[3]).toEqual(['express', 'lodash', 'react'])
            expect(insertQueue!.text).toMatch(/insert into fetch_queue/)
            expect(insertQueue!.params[0]).toEqual(sorted)
        }
    })

    it('drops a purl that repeats a package it already has', async () => {
        const {db, attempts} = transactionDb()
        await createResolveStore(db).createPending([
            parsePurl('pkg:npm/express@4.18.2'),
            parsePurl('pkg:npm/express@4.17.1'),
        ], null)
        expect(attempts[0]![0]!.params[0]).toEqual(['pkg:npm/express'])
    })

    it('queues only the packages its own insert created', async () => {
        // Another chunk of the same run created express a moment ago, and queued it. Asking again
        // would bump the queue row's request count and, if the worker already has it, fetch it
        // twice.
        const attempts: Call[] = []
        const db = {
            async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
                return fn({
                    async query(text: string, params: readonly unknown[] = []) {
                        attempts.push({text, params})
                        if (text.includes('returning package_key')) {
                            return [{package_key: 'pkg:npm/lodash'}, {package_key: 'pkg:npm/react'}]
                        }
                        return []
                    },
                } as Queryable)
            },
        } as unknown as Db

        await createResolveStore(db).createPending(purls, null)

        const queue = attempts.find(c => c.text.includes('insert into fetch_queue'))
        expect(queue!.params[0]).toEqual(['pkg:npm/lodash', 'pkg:npm/react'])
    })

    it('runs the whole transaction again when Postgres picks it as the deadlock victim', async () => {
        const {db, attempts} = transactionDb(attempt => (attempt === 1 ? pgError(DEADLOCK_DETECTED) : undefined))
        const events = {queued: vi.fn(), settled: vi.fn(), onSettled: vi.fn(), onQueued: vi.fn(), wanted: vi.fn(), onWanted: vi.fn(), listeners: 0}

        await createResolveStore(db, events).createPending(purls, null)

        expect(attempts).toHaveLength(2)
        expect(attempts[1]![0]!.params[0]).toEqual(sorted)
        // Only after a commit, and exactly once: the pump must not be sent to an empty queue.
        expect(events.queued).toHaveBeenCalledTimes(1)
    })

    it('gives up if the retry is a victim too, and never says the work was queued', async () => {
        const {db, attempts} = transactionDb(() => pgError(DEADLOCK_DETECTED))
        const events = {queued: vi.fn(), settled: vi.fn(), onSettled: vi.fn(), onQueued: vi.fn(), wanted: vi.fn(), onWanted: vi.fn(), listeners: 0}

        await expect(createResolveStore(db, events).createPending(purls, null)).rejects.toThrow(/40P01/)
        expect(attempts).toHaveLength(2)
        expect(events.queued).not.toHaveBeenCalled()
    })

    it('does not retry anything that is not a deadlock', async () => {
        // A checkout timeout is not a lost race, it is a pool with nothing to give; going round
        // again would only spend another ten seconds finding that out.
        const {db, attempts} = transactionDb(() => new Error('timeout exceeded when trying to connect'))
        await expect(createResolveStore(db).createPending(purls, null)).rejects.toThrow(/timeout exceeded/)
        expect(attempts).toHaveLength(1)
    })
})

describe('queueRefresh', () => {
    /** A `Db` whose plain `query` records each call; `fail` stages a deadlock victim. */
    function queryDb(fail: (call: number) => unknown = () => undefined): {db: Db; calls: Call[]} {
        const calls: Call[] = []
        const db = {
            async query(text: string, params: readonly unknown[] = []) {
                calls.push({text, params})
                const thrown = fail(calls.length)
                if (thrown) throw thrown
                return []
            },
        } as unknown as Db
        return {db, calls}
    }
    const events = () => ({queued: vi.fn(), settled: vi.fn(), onSettled: vi.fn(), onQueued: vi.fn(), wanted: vi.fn(), onWanted: vi.fn(), listeners: 0})

    it('queues at refresh priority, in key order, and only keeps the later deadline of a queued row', async () => {
        const {db, calls} = queryDb()
        const told = events()
        const until = new Date('2026-10-01T12:00:30Z')

        await createResolveStore(db, told).queueRefresh(['pkg:npm/react', 'pkg:npm/express', 'pkg:npm/react'], until)

        expect(calls).toHaveLength(1)
        expect(calls[0]!.text).toMatch(/insert into fetch_queue/)
        // Not `enqueue`'s conflict branch: a counted ask on a row mid-fetch would fetch it twice.
        // The deadline is all a conflict changes.
        const conflict = calls[0]!.text.slice(calls[0]!.text.indexOf('on conflict'))
        expect(conflict).toMatch(/do update\s+set wanted_until = greatest\(fetch_queue\.wanted_until,\s+excluded\.wanted_until\)\)/)
        expect(conflict).not.toMatch(/requests|priority|next_attempt_at/)
        expect(calls[0]!.params).toEqual([['pkg:npm/express', 'pkg:npm/react'], PRIORITY.refresh, until])
        expect(told.queued).toHaveBeenCalledTimes(1)
    })

    it('marks queued rows wanted in key order, never touching their schedule', async () => {
        const {db, calls} = queryDb()
        const until = new Date('2026-10-01T12:00:30Z')

        await createResolveStore(db).markWanted(['pkg:npm/react', 'pkg:npm/express'], until)

        expect(calls).toHaveLength(1)
        expect(calls[0]!.text).toMatch(/set wanted_until = greatest\(wanted_until, \$2::timestamptz\)/)
        expect(calls[0]!.text).not.toMatch(/next_attempt_at/)
        // Only a row a worker holds is announced, carrying the deadline in epoch milliseconds.
        expect(calls[0]!.text).toMatch(/when leased then pg_notify\('package_wanted'/)
        expect(calls[0]!.params).toEqual([['pkg:npm/express', 'pkg:npm/react'], until, String(until.getTime())])
    })

    it('ranks a refresh below a first fetch and a feed event, above a retry', () => {
        expect(PRIORITY.demand).toBeLessThan(PRIORITY.refresh)
        expect(PRIORITY.feed).toBeLessThan(PRIORITY.refresh)
        expect(PRIORITY.refresh).toBeLessThan(PRIORITY.retry)
    })

    it('goes once more when it is the deadlock victim, and no more', async () => {
        const once = queryDb(call => (call === 1 ? pgError(DEADLOCK_DETECTED) : undefined))
        await createResolveStore(once.db).queueRefresh(['pkg:npm/express'], null)
        expect(once.calls).toHaveLength(2)

        const always = queryDb(() => pgError(DEADLOCK_DETECTED))
        const told = events()
        await expect(createResolveStore(always.db, told).queueRefresh(['pkg:npm/express'], null)).rejects.toThrow(/40P01/)
        expect(always.calls).toHaveLength(2)
        expect(told.queued).not.toHaveBeenCalled()
    })
})
