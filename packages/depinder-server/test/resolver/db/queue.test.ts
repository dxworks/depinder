import {describe, expect, it} from 'vitest'
import type {Queryable} from '../../../src/resolver/db/db.js'
import {enqueue, PRIORITY, sortedUnique} from '../../../src/resolver/db/queue.js'

/**
 * The SQL itself belongs to `db.integration.test.ts`. What matters here is the array the statement
 * is handed: it is the insert order, and the insert order is the lock order, so two callers that
 * both carry a package must hand it over identically or they deadlock each other.
 */

function recordingDb(): {db: Queryable; calls: {text: string; params: readonly unknown[]}[]} {
    const calls: {text: string; params: readonly unknown[]}[] = []
    return {
        db: {
            async query(text: string, params: readonly unknown[] = []) {
                calls.push({text, params})
                return []
            },
        },
        calls,
    }
}

describe('sortedUnique', () => {
    it('sorts and drops duplicates', () => {
        expect(sortedUnique(['pkg:npm/b', 'pkg:npm/a', 'pkg:npm/b'])).toEqual(['pkg:npm/a', 'pkg:npm/b'])
    })

    it('gives the same answer whatever order it is asked in', () => {
        const keys = ['pkg:npm/lodash', 'pkg:maven/org.slf4j/slf4j-api', 'pkg:pypi/requests', 'pkg:npm/express']
        expect(sortedUnique([...keys].reverse())).toEqual(sortedUnique(keys))
    })
})

describe('enqueue', () => {
    it('hands the statement one sorted, deduplicated array however the keys arrived', async () => {
        const forward = recordingDb()
        const backward = recordingDb()
        const keys = ['pkg:npm/express', 'pkg:npm/lodash', 'pkg:npm/react']

        await enqueue(forward.db, [...keys, 'pkg:npm/express'], PRIORITY.demand)
        await enqueue(backward.db, [...keys].reverse(), PRIORITY.feed)

        // The insert order is the lock order: identical here is what makes the two safe together.
        expect(forward.calls[0]!.params[0]).toEqual(keys)
        expect(backward.calls[0]!.params[0]).toEqual(keys)
        expect(forward.calls[0]!.params[1]).toBe(PRIORITY.demand)
        expect(backward.calls[0]!.params[1]).toBe(PRIORITY.feed)
    })

    it('carries a caller\'s deadline, and keeps the later one on a conflict', async () => {
        const {db, calls} = recordingDb()
        const until = new Date('2026-10-01T12:00:30Z')
        await enqueue(db, ['pkg:npm/express'], PRIORITY.demand, until)
        await enqueue(db, ['pkg:npm/express'], PRIORITY.feed)
        expect(calls[0]!.params[2]).toBe(until)
        // A feed event has no caller: null, which `greatest` skips rather than clearing the deadline.
        expect(calls[1]!.params[2]).toBeNull()
        expect(calls[0]!.text).toMatch(/wanted_until = greatest\(fetch_queue\.wanted_until, excluded\.wanted_until\)/)
    })

    it('no longer asks Postgres to deduplicate, because a hash aggregate picks its own order', async () => {
        const {db, calls} = recordingDb()
        await enqueue(db, ['pkg:npm/express'], PRIORITY.demand)
        expect(calls[0]!.text).not.toMatch(/distinct/i)
    })

    it('costs no query when there is nothing to queue', async () => {
        const {db, calls} = recordingDb()
        await enqueue(db, [], PRIORITY.demand)
        expect(calls).toEqual([])
    })
})
