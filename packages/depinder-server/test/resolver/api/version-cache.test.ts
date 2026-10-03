import {describe, expect, it} from 'vitest'
import {createVersionCache} from '../../../src/resolver/api/version-cache.js'
import type {CompactVersion} from '../../../src/resolver/db/rows.js'

/**
 * The cache is only ever read against a `package` row read in the same request, so the interesting
 * cases are all about `fetched_at`: an entry stored under one is invisible under any other. The
 * bound is the second half — an api process that answers a few million distinct packages must not
 * grow without limit.
 */

const one: CompactVersion[] = [['1.0.0', 1_700_000_000, 0]]
const two: CompactVersion[] = [['2.0.0', 1_800_000_000, 0]]
const at = (iso: string): Date => new Date(iso)

describe('createVersionCache', () => {
    it('serves what it stored under the same fetched_at', () => {
        const cache = createVersionCache(10)
        cache.set('pkg:npm/express', at('2026-09-16T10:00:00Z'), one)

        expect(cache.get('pkg:npm/express', at('2026-09-16T10:00:00Z'))).toBe(one)
        expect(cache.size).toBe(1)
    })

    it('misses a package it has never held', () => {
        const cache = createVersionCache(10)
        expect(cache.get('pkg:npm/express', at('2026-09-16T10:00:00Z'))).toBeUndefined()
    })

    it('misses when the row was refetched, however small the difference', () => {
        const cache = createVersionCache(10)
        cache.set('pkg:npm/express', at('2026-09-16T10:00:00.000Z'), one)

        // The worker stamps a fresh fetched_at in the transaction that replaces the versions, so a
        // different fetched_at means a different version list — even one millisecond later.
        expect(cache.get('pkg:npm/express', at('2026-09-16T10:00:00.001Z'))).toBeUndefined()

        cache.set('pkg:npm/express', at('2026-09-16T10:00:00.001Z'), two)
        expect(cache.get('pkg:npm/express', at('2026-09-16T10:00:00.001Z'))).toBe(two)
        expect(cache.get('pkg:npm/express', at('2026-09-16T10:00:00.000Z'))).toBeUndefined()
        // Refetching replaces the entry rather than adding one.
        expect(cache.size).toBe(1)
    })

    it('holds no more packages than it was given, and evicts the least recently used', () => {
        const cache = createVersionCache(3)
        const fetchedAt = at('2026-09-16T10:00:00Z')
        for (const key of ['a', 'b', 'c']) cache.set(key, fetchedAt, one)

        // Reading `a` makes `b` the oldest, so `b` is what a fourth package pushes out.
        expect(cache.get('a', fetchedAt)).toBe(one)
        cache.set('d', fetchedAt, two)

        expect(cache.size).toBe(3)
        expect(cache.get('b', fetchedAt)).toBeUndefined()
        expect(cache.get('a', fetchedAt)).toBe(one)
        expect(cache.get('c', fetchedAt)).toBe(one)
        expect(cache.get('d', fetchedAt)).toBe(two)
    })

    it('holds nothing at all when it is switched off', () => {
        const cache = createVersionCache(0)
        cache.set('pkg:npm/express', at('2026-09-16T10:00:00Z'), one)

        expect(cache.get('pkg:npm/express', at('2026-09-16T10:00:00Z'))).toBeUndefined()
        expect(cache.size).toBe(0)
    })
})
