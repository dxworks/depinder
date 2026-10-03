import {CELLS, type Cell, type RunRecord} from './summary.js'

/**
 * Which runs of A are compared with which runs of B. By default every cell with itself; with
 * `--pair <cellA>[@N]:<cellB>[@N]` one cell of A with another of B (or of the same run), for
 * instance `no-server:warm-server`, or `warm-server@1:warm-server@2` for determinism.
 */

export interface CellRef {
    cell: Cell
    /** That repeat alone; when absent, every repeat for timings and the first run's output. */
    repeat: number | null
}

export interface CellPair {
    a: CellRef
    b: CellRef
}

/** One comparison: a label, the runs on each side (for timings), and the output folder ids. */
export interface Comparison {
    label: string
    runsA: RunRecord[]
    runsB: RunRecord[]
    outA: string
    outB: string
}

function parseRef(text: string): CellRef {
    const [cell, repeat] = text.split('@')
    if (!CELLS.includes(cell as Cell)) throw new Error(`--pair: unknown cell "${cell}" (one of ${CELLS.join(', ')})`)
    if (repeat === undefined) return {cell: cell as Cell, repeat: null}
    const n = Number(repeat)
    if (!Number.isInteger(n) || n < 1) throw new Error(`--pair: "${text}" needs a repeat number >= 1 after @`)
    if (cell === 'empty') throw new Error('--pair: the empty cell runs once and has no repeats')
    return {cell: cell as Cell, repeat: n}
}

export function parsePair(text: string): CellPair {
    const sides = text.split(':')
    if (sides.length !== 2) throw new Error(`--pair "${text}": expected <cellA>[@N]:<cellB>[@N]`)
    return {a: parseRef(sides[0]), b: parseRef(sides[1])}
}

function outputId(ref: CellRef, producer: string): string {
    return ref.cell === 'empty' ? `empty-${producer}` : `${ref.cell}-${producer}-${ref.repeat ?? 1}`
}

function matches(run: RunRecord, ref: CellRef, producer: string): boolean {
    return run.cell === ref.cell && run.producer === producer && (ref.repeat === null || run.repeat === ref.repeat)
}

const refLabel = (ref: CellRef) => ref.repeat === null ? ref.cell : `${ref.cell}@${ref.repeat}`

/** Every cell/producer both runs have, each with itself, in cell order. */
export function sameCellComparisons(a: RunRecord[], b: RunRecord[]): Comparison[] {
    const pairs = CELLS.map(cell => ({a: {cell, repeat: null}, b: {cell, repeat: null}}))
    return pairs.flatMap(pair => pairComparisons(pair, a, b))
}

/** One comparison per producer that ran cell A in run A and cell B in run B. */
export function pairComparisons(pair: CellPair, a: RunRecord[], b: RunRecord[]): Comparison[] {
    const producers = [...new Set(a.map(r => r.producer))]
        .filter(p => a.some(r => matches(r, pair.a, p)) && b.some(r => matches(r, pair.b, p)))
    const same = pair.a.cell === pair.b.cell && pair.a.repeat === pair.b.repeat
    return producers.map(producer => ({
        label: same ? `${refLabel(pair.a)}/${producer}` : `${refLabel(pair.a)} vs ${refLabel(pair.b)}/${producer}`,
        runsA: a.filter(r => matches(r, pair.a, producer)),
        runsB: b.filter(r => matches(r, pair.b, producer)),
        outA: outputId(pair.a, producer),
        outB: outputId(pair.b, producer),
    }))
}
