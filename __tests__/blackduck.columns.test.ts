import {blackDuckDateToTabIso, countCell, isoToTabIso, normalizeMatchType} from '../src/blackduck/columns'

describe('the shared Black Duck cell conventions', () => {
    it('drops the word Dependency from a match type', () => {
        expect(normalizeMatchType('Direct Dependency')).toBe('Direct')
        expect(normalizeMatchType('Transitive Dependency')).toBe('Transitive')
        expect(normalizeMatchType('Direct Dependency,Transitive Dependency')).toBe('Direct,Transitive')
        expect(normalizeMatchType('')).toBe('')
    })

    it('writes dates as tab-prefixed ISO, from either dialect', () => {
        expect(isoToTabIso('2026-07-24')).toBe('\t2026-07-24')
        expect(isoToTabIso('')).toBe('')
        expect(blackDuckDateToTabIso('7/24/26')).toBe('\t2026-07-24')
        expect(blackDuckDateToTabIso('12/1/99')).toBe('\t1999-12-01')
        expect(blackDuckDateToTabIso('2026-07-24')).toBe('')
        expect(blackDuckDateToTabIso('')).toBe('')
    })

    it('leaves a zero per-severity count blank', () => {
        expect(countCell(0)).toBe('')
        expect(countCell(3)).toBe('3')
    })
})
