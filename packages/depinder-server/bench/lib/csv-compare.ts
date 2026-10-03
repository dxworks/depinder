import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import path from 'node:path'
import {DIFF_CLASSES, isSummaryFile, type DiffClass, type DifferenceClassifier} from './allowed-differences.js'

/**
 * Compares two depinder output folders CSV by CSV: rows matched by key (not by position, so a
 * reordering is not a difference), then column by column. Ported from tools/compare.mjs.
 *
 * Some columns differ between any two runs for reasons that are not the code: they measure from
 * "now", or name the folder. Those are left out, by name, so that anything else that differs is
 * worth a look.
 */

/** Months from "now": ignored only when the two runs measured from different dates (or the real clock). */
const CLOCK_COLUMNS = new Set(['Now-Used', 'Now-latest'])
/** The Black Duck report name, taken from the input folder; ignored in case the folder is renamed. */
const PER_FILE_IGNORED: Readonly<Record<string, readonly string[]>> = {
    'security.csv': ['Project path'],
    '_vulnerability_details.csv': ['Project path'],
}

/**
 * The columns that say which thing a row is about, in the order they make up its key. A file uses
 * the ones it has; a key seen twice gets `#2`, `#3`, ... so duplicate rows still pair up in order.
 */
const KEY_COLUMNS = [
    'Project Path', 'Project', 'Library', 'Used Version',
    'Used by', 'Repo', 'Tree', 'Ecosystem', 'Parent Origin Id', 'Child Origin Id',
    'Component name', 'Component Name', 'Component version name', 'Component Version Name',
    'Component Version Origin Id', 'Origin id', 'Vulnerability id', 'Path', 'ProjectPath', 'License',
]

/** RFC 4180-ish: quoted fields, doubled quotes inside them, and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let field = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
            } else field += ch
        } else if (ch === '"') quoted = true
        else if (ch === ',') { row.push(field); field = '' }
        else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = '' }
        else if (ch !== '\r') field += ch
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row) }
    return rows
}

interface Table {
    header: string[]
    rows: Map<string, string[]>
}

function readTable(file: string): Table {
    const [header = [], ...body] = parseCsv(readFileSync(file, 'utf8'))
    const keyIdx = KEY_COLUMNS.map(c => header.indexOf(c)).filter(i => i >= 0)
    const rows = new Map<string, string[]>()
    for (const row of body) {
        if (row.length <= 1 && (row[0] ?? '') === '') continue
        const base = keyIdx.length ? keyIdx.map(i => row[i] ?? '').join(' | ') : row.join(',')
        let key = base
        for (let n = 2; rows.has(key); n++) key = `${base} #${n}`
        rows.set(key, row)
    }
    return {header, rows}
}

/** Every CSV under `dir`, as paths relative to it. */
function csvFiles(dir: string): string[] {
    if (!existsSync(dir)) return []
    return readdirSync(dir, {recursive: true, encoding: 'utf8'})
        .filter(f => f.endsWith('.csv') && statSync(path.join(dir, f)).isFile())
        .sort()
}

export interface ColumnDiff {
    count: number
    byClass: Record<DiffClass, number>
    examples: {key: string, a: string, b: string, class: DiffClass}[]
}

export interface FileDiff {
    file: string
    /** Set when the file is in one folder only. */
    onlyIn?: 'A' | 'B'
    headerChanged: boolean
    onlyA: string[]
    onlyB: string[]
    /** How the rows only in A or only in B are classified (a header change is a regression). */
    missingRowClass: DiffClass
    columns: Map<string, ColumnDiff>
}

export interface DirComparison {
    files: number
    identical: number
    diffs: FileDiff[]
    /** Rows in one folder only plus differing cells, outside the ignored columns. */
    differences: number
    /** The same differences by class: what the regression rules allow and what they do not. */
    byClass: Record<DiffClass, number>
}

/** Examples kept per column: regressions first, a few of each allowed class. */
const MAX_EXAMPLES: Record<DiffClass, number> = {'regression': 10, 'newer-release': 3, 'vuln-db': 3}
const zeroByClass = (): Record<DiffClass, number> => ({'regression': 0, 'newer-release': 0, 'vuln-db': 0})

function compareFile(file: string, a: Table, b: Table, ignoreClock: boolean, classifier: DifferenceClassifier): FileDiff {
    const ignored = new Set([...(ignoreClock ? CLOCK_COLUMNS : []), ...(PER_FILE_IGNORED[path.basename(file)] ?? [])])
    const diff: FileDiff = {
        file, headerChanged: a.header.join(',') !== b.header.join(','),
        onlyA: [...a.rows.keys()].filter(k => !b.rows.has(k)),
        onlyB: [...b.rows.keys()].filter(k => !a.rows.has(k)),
        missingRowClass: classifier.missingRow(file),
        columns: new Map(),
    }
    for (const [key, aRow] of a.rows) {
        const bRow = b.rows.get(key)
        if (!bRow) continue
        const changed = a.header.flatMap((col, i) => {
            if (ignored.has(col)) return []
            const av = aRow[i] ?? ''
            const bi = b.header.indexOf(col)
            const bv = bi < 0 ? '' : bRow[bi] ?? ''
            return av === bv ? [] : [{col, av, bv}]
        })
        if (changed.length === 0) continue
        const rowClass = classifier.changedRow(file, b.header, bRow, changed.map(c => c.col))
        for (const {col, av, bv} of changed) {
            const stat = diff.columns.get(col) ?? {count: 0, byClass: zeroByClass(), examples: []}
            stat.count++
            stat.byClass[rowClass]++
            if (stat.examples.filter(ex => ex.class === rowClass).length < MAX_EXAMPLES[rowClass]) {
                stat.examples.push({key, a: av.slice(0, 100), b: bv.slice(0, 100), class: rowClass})
            }
            diff.columns.set(col, stat)
        }
    }
    return diff
}

function countByClass(diff: FileDiff): Record<DiffClass, number> {
    const counts = zeroByClass()
    counts[diff.missingRowClass] += diff.onlyA.length + diff.onlyB.length
    if (diff.headerChanged || diff.onlyIn) counts.regression++
    for (const column of diff.columns.values()) for (const c of DIFF_CLASSES) counts[c] += column.byClass[c]
    return counts
}

/** Row files before summary files: a summary's differences follow its ecosystem's rows. */
const classificationOrder = (x: string, y: string) => Number(isSummaryFile(x)) - Number(isSummaryFile(y)) || x.localeCompare(y)

export function compareDirs(dirA: string, dirB: string, ignoreClock: boolean, classifier: DifferenceClassifier): DirComparison {
    const files = [...new Set([...csvFiles(dirA), ...csvFiles(dirB)])].sort(classificationOrder)
    const result: DirComparison = {files: files.length, identical: 0, diffs: [], differences: 0, byClass: zeroByClass()}
    for (const file of files) {
        const fa = path.join(dirA, file)
        const fb = path.join(dirB, file)
        const inA = existsSync(fa)
        const inB = existsSync(fb)
        if (inA && inB && readFileSync(fa).equals(readFileSync(fb))) {
            result.identical++
            continue
        }
        const diff: FileDiff = inA && inB
            ? compareFile(file, readTable(fa), readTable(fb), ignoreClock, classifier)
            : {file, onlyIn: inA ? 'A' : 'B', headerChanged: false, onlyA: [], onlyB: [], missingRowClass: 'regression', columns: new Map()}
        const counts = countByClass(diff)
        const n = DIFF_CLASSES.reduce((sum, c) => sum + counts[c], 0)
        if (n === 0) {
            result.identical++
            continue
        }
        result.diffs.push(diff)
        result.differences += n
        for (const c of DIFF_CLASSES) result.byClass[c] += counts[c]
    }
    return result
}

const CLASS_LABELS: Record<DiffClass, string> = {'regression': 'regression', 'newer-release': 'newer release', 'vuln-db': 'vulnerability database'}

/** "3 regression, 12 newer release" for the classes that occur. */
export function describeClasses(counts: Record<DiffClass, number>): string {
    return DIFF_CLASSES.filter(c => counts[c] > 0).map(c => `${counts[c]} ${CLASS_LABELS[c]}`).join(', ')
}

/** Human-readable lines for one folder pair; empty when nothing differs. */
export function formatComparison(c: DirComparison): string[] {
    const lines: string[] = [`  ${c.identical}/${c.files} CSV files identical`]
    for (const d of c.diffs) {
        if (d.onlyIn) { lines.push(`  ${d.file}: only in ${d.onlyIn}`); continue }
        const missing = d.onlyA.length + d.onlyB.length ? ` (${CLASS_LABELS[d.missingRowClass]})` : ''
        lines.push(`  ${d.file}:${d.headerChanged ? ' header differs;' : ''} rows only in A ${d.onlyA.length}, only in B ${d.onlyB.length}${missing}`)
        for (const k of d.onlyA.slice(0, 3)) lines.push(`      only A: ${k}`)
        for (const k of d.onlyB.slice(0, 3)) lines.push(`      only B: ${k}`)
        for (const [col, s] of [...d.columns].sort((x, y) => y[1].count - x[1].count)) {
            lines.push(`    column "${col}": ${s.count} cell(s) differ (${describeClasses(s.byClass)})`)
            for (const ex of s.examples) {
                lines.push(`      [${CLASS_LABELS[ex.class]}] ${ex.key}\n        A: ${ex.a || '(blank)'}\n        B: ${ex.b || '(blank)'}`)
            }
        }
    }
    return lines
}
