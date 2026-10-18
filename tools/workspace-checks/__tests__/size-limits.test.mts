import {describe, expect, it} from 'vitest'
import {checkSizes, classify, countLines} from '../src/size-limits.mts'

const lines = (n: number) => 'x\n'.repeat(n)

describe('classify', () => {
    it('tells code from tests and skips declarations, fixtures and non-code', () => {
        expect(classify('packages/a/src/run.ts')).toBe('code')
        expect(classify('packages/a/__tests__/run.test.ts')).toBe('test')
        expect(classify('packages/a/src/run.spec.mts')).toBe('test')
        expect(classify('packages/a/src/types.d.ts')).toBeNull()
        expect(classify('packages/a/__tests__/fixtures/npm/big.js')).toBeNull()
        expect(classify('packages/a/README.md')).toBeNull()
    })
})

describe('countLines', () => {
    it('counts lines with or without a final newline', () => {
        expect(countLines('')).toBe(0)
        expect(countLines(lines(3))).toBe(3)
        expect(countLines('a\nb')).toBe(2)
    })
})

describe('checkSizes', () => {
    const noBaseline = {files: {}, longFunctions: []}

    it('fails a file over its hard limit and warns over the target', () => {
        const report = checkSizes({'src/big.ts': 401, 'src/long.ts': 351, 'src/ok.ts': 350, '__tests__/t.test.ts': 551}, noBaseline)
        expect(report.errors).toEqual([
            'src/big.ts: 401 lines, over the code limit of 400',
            '__tests__/t.test.ts: 551 lines, over the test limit of 550',
        ])
        expect(report.warnings).toEqual(['src/long.ts: 351 lines, over the code target of 350'])
    })

    it('lets a baseline file keep or shrink its size but not grow', () => {
        const baseline = {files: {'src/old.ts': 1000, 'src/older.ts': 900}, longFunctions: []}
        expect(checkSizes({'src/old.ts': 1000, 'src/older.ts': 850}, baseline).errors).toEqual([])
        expect(checkSizes({'src/old.ts': 1001, 'src/older.ts': 900}, baseline).errors)
            .toEqual(['src/old.ts: 1001 lines, grew past its baseline of 1000'])
    })

    it('notes a baseline entry whose file is gone', () => {
        const report = checkSizes({}, {files: {'src/gone.ts': 500}, longFunctions: []})
        expect(report.warnings).toEqual(['src/gone.ts: in the baseline but gone; remove it from size-baseline.json'])
    })
})
