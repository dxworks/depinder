import {describe, expect, it} from 'vitest'
import {parsePurl} from '@depinder/core'
import {FIRST_CHECK_MARGIN_MS, modified, notModified} from '../../../src/resolver/registries/shared.js'
import type {PollTarget} from '../../../src/resolver/registries/types.js'

/**
 * What a conditional GET vouches for, shared by maven and cargo. The registry tests cover the
 * wiring; these cover the edges of the rule itself, which is what decides whether a package's
 * `as_of` may move without a fetch.
 */

const FETCHED_AT = new Date('2026-09-01T12:00:00Z')

function target(overrides: Partial<PollTarget> = {}): PollTarget {
    const packageKey = 'pkg:cargo/serde'
    return {packageKey, key: parsePurl(packageKey), etag: null, lastModified: null, fetchedAt: FETCHED_AT, ...overrides}
}

function lastModified(offsetMs: number): Headers {
    return new Headers({etag: '"v"', 'last-modified': new Date(FETCHED_AT.getTime() + offsetMs).toUTCString()})
}

describe('a first check', () => {
    it('vouches for the fetch when the file last changed more than the margin before it', () => {
        const result = modified(target(), lastModified(-FIRST_CHECK_MARGIN_MS - 1_000))
        expect(result.changed).toBe(false)
        expect(result.confirmed).toBe(true)
        expect(result.etag).toBe('"v"')
    })

    it('requeues when the file changed inside the margin, because the fetch may have missed it', () => {
        // A CDN copy from just before a publish, or our clock running ahead of theirs.
        expect(modified(target(), lastModified(-FIRST_CHECK_MARGIN_MS + 1_000))).toEqual({
            changed: true,
            confirmed: false,
        })
    })

    it('requeues when the file changed after the fetch', () => {
        expect(modified(target(), lastModified(60_000))).toEqual({changed: true, confirmed: false})
    })

    it('stores an unparseable Last-Modified but vouches for nothing', () => {
        const headers = new Headers({etag: '"v"', 'last-modified': 'yesterday-ish'})
        expect(modified(target(), headers)).toEqual({
            changed: false,
            confirmed: false,
            etag: '"v"',
            lastModified: 'yesterday-ish',
        })
    })
})

describe('a later check', () => {
    it('treats a 200 against stored validators as a change whatever Last-Modified says', () => {
        expect(modified(target({etag: '"old"'}), lastModified(-365 * 24 * 3_600_000))).toEqual({
            changed: true,
            confirmed: false,
            etag: null,
            lastModified: null,
        })
    })

    it('vouches on a 304 only for a package that has been fetched in full', () => {
        expect(notModified(target({etag: '"v"'}))).toEqual({changed: false, confirmed: true})
        expect(notModified(target({etag: '"v"', fetchedAt: null}))).toEqual({changed: false, confirmed: false})
    })
})
