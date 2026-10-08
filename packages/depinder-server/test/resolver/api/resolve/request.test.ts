import {describe, expect, it} from 'vitest'
import {parseResolveRequest} from '../../../../src/resolver/api/resolve/request.js'
import {RESOLVE_DEFAULT_DEADLINE_MS, RESOLVE_DEFAULT_MAX_AGE_S, RESOLVE_MAX_DEADLINE_MS} from '@depinder/core'
import {BadRequestError} from '../../../../src/shared/errors.js'

describe('parseResolveRequest', () => {
    it('accepts a plain request', () => {
        expect(parseResolveRequest({purls: ['pkg:npm/express@4.18.2']})).toEqual({
            purls: ['pkg:npm/express@4.18.2'],
            deadlineMs: RESOLVE_DEFAULT_DEADLINE_MS,
            maxAgeS: RESOLVE_DEFAULT_MAX_AGE_S,
        })
        expect(RESOLVE_DEFAULT_DEADLINE_MS).toBe(10_000)
    })

    it('reads deadline_ms, up to a minute, and 0 for "what you have now"', () => {
        expect(parseResolveRequest({purls: [], deadline_ms: 0}).deadlineMs).toBe(0)
        expect(parseResolveRequest({purls: [], deadline_ms: null}).deadlineMs).toBe(RESOLVE_DEFAULT_DEADLINE_MS)
        expect(parseResolveRequest({purls: [], deadline_ms: RESOLVE_MAX_DEADLINE_MS}).deadlineMs).toBe(60_000)
        expect(() => parseResolveRequest({purls: [], deadline_ms: 60_001})).toThrow(/deadline_ms/)
        expect(() => parseResolveRequest({purls: [], deadline_ms: -1})).toThrow(/deadline_ms/)
        expect(() => parseResolveRequest({purls: [], deadline_ms: '10s'})).toThrow(/deadline_ms/)
    })

    it('refuses wait_ms by naming the field that replaced it', () => {
        // An old client must fail loudly rather than be handed a stream it cannot read.
        for (const waitMs of [0, 10_000, null]) {
            expect(() => parseResolveRequest({purls: [], wait_ms: waitMs})).toThrow(BadRequestError)
            expect(() => parseResolveRequest({purls: [], wait_ms: waitMs})).toThrow(/"deadline_ms"/)
        }
    })

    it('rejects a malformed body', () => {
        expect(() => parseResolveRequest(null)).toThrow(BadRequestError)
        expect(() => parseResolveRequest({})).toThrow(/purls/)
        expect(() => parseResolveRequest({purls: [1, 2]})).toThrow(/strings/)
        expect(() => parseResolveRequest({purls: new Array(5001).fill('pkg:npm/a')})).toThrow(/maximum is 5000/)
        expect(() => parseResolveRequest({purls: [], max_age: -1})).toThrow(/max_age/)
        expect(() => parseResolveRequest({purls: [], max_age: '1d'})).toThrow(/max_age/)
        expect(() => parseResolveRequest({purls: [], max_age: Infinity})).toThrow(/max_age/)
    })

    it('reads max_age in seconds, and gives a request without one a day', () => {
        expect(RESOLVE_DEFAULT_MAX_AGE_S).toBe(86_400)
        expect(parseResolveRequest({purls: []}).maxAgeS).toBe(86_400)
        expect(parseResolveRequest({purls: [], max_age: null}).maxAgeS).toBe(86_400)
        expect(parseResolveRequest({purls: [], max_age: 3600}).maxAgeS).toBe(3600)
        expect(parseResolveRequest({purls: [], max_age: 0}).maxAgeS).toBe(0)
    })
})
