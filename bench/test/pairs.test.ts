import {describe, expect, it} from 'vitest'
import {outputId, parsePair, selfComparisons} from '../lib/pairs.js'
import type {Cell, RunRecord} from '../lib/summary.js'

// Which runs the compare puts side by side, in particular the cold-then-warm self-checks.

function record(cell: Cell, producer: string, repeat: number | null): RunRecord {
    return {
        id: repeat === null ? `${cell}-${producer}` : `${cell}-${producer}-${repeat}`, cell, producer, repeat,
        start: '', end: '', wall: 1, code: 0, loadBefore: [], loadAfter: [], picks: {} as RunRecord['picks'], phases: {}, counters: {},
    }
}

const fullRun: RunRecord[] = ['trivy', 'syft'].flatMap(p => [
    record('empty', p, null), record('warm-after-empty', p, null),
    ...[1, 2].flatMap(i => [record('warm-server', p, i), record('warm-both', p, i), record('no-server', p, i), record('warm-after-no-server', p, i)]),
])

describe('parsePair', () => {
    it('accepts the warm-after cells', () => {
        expect(parsePair('no-server@2:warm-after-no-server@2')).toEqual({
            a: {cell: 'no-server', repeat: 2}, b: {cell: 'warm-after-no-server', repeat: 2},
        })
        expect(parsePair('empty:warm-after-empty').b).toEqual({cell: 'warm-after-empty', repeat: null})
    })

    it('refuses a repeat on a cell that runs once', () => {
        expect(() => parsePair('empty:warm-after-empty@1')).toThrow(/runs once/)
    })
})

describe('outputId', () => {
    it('names once-cells without a repeat and repeated cells with one', () => {
        expect(outputId({cell: 'warm-after-empty', repeat: null}, 'syft')).toBe('warm-after-empty-syft')
        expect(outputId({cell: 'warm-after-no-server', repeat: null}, 'syft')).toBe('warm-after-no-server-syft-1')
    })
})

describe('selfComparisons', () => {
    const labels = selfComparisons(fullRun).map(c => `${c.outA} | ${c.outB}`)

    it('pairs each cold cell with its warm rerun on the same cache', () => {
        expect(labels).toContain('empty-trivy | warm-after-empty-trivy')
        expect(labels).toContain('no-server-syft-1 | warm-after-no-server-syft-1')
        expect(labels).toContain('no-server-syft-2 | warm-after-no-server-syft-2')
    })

    it('checks repeat 1 against the later repeats of every repeated cell', () => {
        expect(labels).toContain('warm-server-trivy-1 | warm-server-trivy-2')
        expect(labels).toContain('warm-after-no-server-syft-1 | warm-after-no-server-syft-2')
        expect(labels.some(l => l.startsWith('empty-trivy | empty'))).toBe(false)
    })

    it('has 2 producers x (1 + 2 cold-then-warm + 4 determinism) comparisons', () => {
        expect(labels).toHaveLength(14)
    })

    it('skips the cold-then-warm pair when the warm cell did not run', () => {
        const old = fullRun.filter(r => !r.cell.startsWith('warm-after'))
        expect(selfComparisons(old).map(c => c.outB).some(o => o.startsWith('warm-after'))).toBe(false)
    })
})
