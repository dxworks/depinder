import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {DifferenceClassifier, referenceFacts, type DiffClass} from './lib/allowed-differences.js'
import {compareDirs, describeClasses, formatComparison} from './lib/csv-compare.js'
import {pairComparisons, parsePair, sameCellComparisons, type Comparison} from './lib/pairs.js'
import {median} from './lib/profile.js'
import {groupRuns, type RunRecord} from './lib/summary.js'
import {RUNS_DIR} from './lib/targets.js'

/**
 * Two bench runs side by side: timings per cell and producer, the counters that moved in the warm
 * cells, and the CSV output of the first run of each cell compared row by row. `--pair` compares
 * one cell with another instead (A and B may be the same run).
 *
 *   npm run bench:compare -- <runDirA> <runDirB> [--pair <cellA>[@N]:<cellB>[@N]]...
 *
 * A run folder can be given as a path or by its name under bench/runs/. Always exits 0; the last
 * line is the verdict. A is the reference: CSV differences are sorted into regressions and the
 * differences the regression rules allow (lib/allowed-differences.ts).
 */

const USAGE = 'usage: npm run bench:compare -- <runDirA> <runDirB> [--pair <cellA>[@N]:<cellB>[@N]]...'

/** The folder as given, or the run of that name under bench/runs/. */
function runDir(arg: string): string {
    if (existsSync(path.join(arg, 'results.jsonl'))) return arg
    const named = path.join(RUNS_DIR, path.basename(arg))
    return existsSync(path.join(named, 'results.jsonl')) ? named : arg
}

function load(dir: string): RunRecord[] {
    const file = path.join(dir, 'results.jsonl')
    if (!existsSync(file)) throw new Error(`${file} not found: is ${dir} a bench run folder?`)
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as RunRecord)
}

/** The fixed date the run's depinder measured ages from; null for runs from before it was recorded. */
function reportNow(dir: string): string | null {
    const file = path.join(dir, 'run.json')
    if (!existsSync(file)) return null
    return (JSON.parse(readFileSync(file, 'utf8')) as {reportNow?: string}).reportNow ?? null
}

const pad = (s: string, n: number) => s.padStart(n)

/** Prints the table; returns the largest change in percent over the comparisons. */
function timings(comparisons: Comparison[]): number {
    let worst = 0
    console.log('TIMINGS (median wall seconds)')
    console.log(`  ${'cell/producer'.padEnd(34)} ${pad('A', 8)} ${pad('B', 8)} ${pad('delta s', 9)} ${pad('delta %', 8)}`)
    for (const c of comparisons) {
        const ma = median(c.runsA.map(r => r.wall))
        const mb = median(c.runsB.map(r => r.wall))
        const d = mb - ma
        const pct = ma ? (d / ma) * 100 : null
        if (pct !== null && Math.abs(pct) > Math.abs(worst)) worst = pct
        console.log(`  ${c.label.padEnd(34)} ${pad(ma.toFixed(1), 8)} ${pad(mb.toFixed(1), 8)} `
            + `${pad((d >= 0 ? '+' : '') + d.toFixed(1), 9)} ${pad(pct === null ? '-' : (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%', 8)}`)
    }
    if (comparisons.length === 0) console.log('  no cell ran in both')
    console.log()
    return worst
}

/**
 * Counters whose median moved, for the cells that start on a filled server only: the empty cell's
 * counters depend on how fast the registries answered that day, so a difference there says
 * little about the code.
 */
function counters(a: Map<string, RunRecord[]>, b: Map<string, RunRecord[]>): number {
    console.log('COUNTERS THAT DIFFER (warm and no-server cells, medians; vuln:server-timing:* left out)')
    let moved = 0
    for (const [key, runsA] of a) {
        const runsB = b.get(key)
        if (!runsB || key.startsWith('empty/')) continue
        const names = new Set([...runsA, ...runsB].flatMap(r => Object.keys(r.counters)))
        for (const name of [...names].sort()) {
            if (name.startsWith('vuln:server-timing:')) continue
            const va = median(runsA.map(r => r.counters[name] ?? 0))
            const vb = median(runsB.map(r => r.counters[name] ?? 0))
            if (va === vb) continue
            moved++
            console.log(`  ${key.padEnd(22)} ${name.padEnd(36)} ${pad(String(va), 8)} -> ${pad(String(vb), 8)}`)
        }
    }
    if (!moved) console.log('  none')
    console.log()
    return moved
}

/** The CSV output of each comparison, folder by folder; returns the differences by class. */
function outputs(dirA: string, dirB: string, comparisons: Comparison[], ignoreClock: boolean): Record<DiffClass, number> {
    console.log(`CSV OUTPUT (first run of each cell unless @N is given; ${ignoreClock ? 'Now-Used, Now-latest and ' : ''}Project path ignored)`)
    const facts = referenceFacts(dirA, dirB)
    if (facts) {
        console.log(`  newer release = a version B's cache dates after A started (${facts.startedAt.toISOString()}); `
            + `vulnerability databases ${facts.vulnDbsDiffer ? 'DIFFER between A and B' : 'are the same builds'}`)
    }
    const total: Record<DiffClass, number> = {'regression': 0, 'newer-release': 0, 'vuln-db': 0}
    for (const cmp of comparisons) {
        // warm-both reruns on the cache its warm-server repeat left
        const cacheB = cmp.outB.replace(/^warm-both-/, 'warm-server-')
        const classifier = DifferenceClassifier.open(facts, path.join(dirB, 'caches', `${cacheB}.sqlite`))
        const c = compareDirs(path.join(dirA, 'out', cmp.outA), path.join(dirB, 'out', cmp.outB), ignoreClock, classifier)
        classifier.close()
        for (const k of Object.keys(total) as DiffClass[]) total[k] += c.byClass[k]
        const noCache = classifier.canTellNewerReleases ? '' : ' (no B cache kept: newer releases cannot be told apart)'
        console.log(`${cmp.outA === cmp.outB ? cmp.outA : `${cmp.outA} vs ${cmp.outB}`}: `
            + (c.differences === 0 ? 'identical' : `${c.differences} difference(s): ${describeClasses(c.byClass)}${noCache}`))
        if (c.differences) for (const line of formatComparison(c)) console.log(line)
    }
    if (comparisons.length === 0) console.log('  no cell ran in both')
    console.log()
    return total
}

function main(): void {
    const {values, positionals} = parseArgs({allowPositionals: true, options: {
        pair: {type: 'string', multiple: true},
    }})
    const [argA, argB] = positionals
    if (!argA || !argB) {
        console.log(USAGE)
        return
    }
    const pairs = (values.pair ?? []).map(parsePair)
    const dirA = runDir(argA)
    const dirB = runDir(argB)
    const a = load(dirA)
    const b = load(dirB)
    const nowA = reportNow(dirA)
    const nowB = reportNow(dirB)
    console.log(`A: ${dirA}\nB: ${dirB}\nAges measured from: A ${nowA ?? 'the real clock'}, B ${nowB ?? 'the real clock'}`)
    // Same fixed date: the age columns are deterministic and compared. Otherwise they move by themselves.
    const ignoreClock = nowA === null || nowA !== nowB
    if (ignoreClock) console.log('WARNING: no common fixed date: Now-Used and Now-latest are ignored, and Operational Risk '
        + 'and the Out of Support counts can differ by age alone')
    console.log()

    const comparisons = pairs.length
        ? pairs.flatMap(pair => pairComparisons(pair, a, b))
        : sameCellComparisons(a, b)
    const worst = timings(comparisons)
    // Counters of two different cells differ by design; a pair compare is judged on its CSVs.
    const moved = pairs.length ? 0 : counters(groupRuns(a), groupRuns(b))
    const byClass = outputs(dirA, dirB, comparisons, ignoreClock)
    const regressions = byClass.regression
    const allowed = byClass['newer-release'] + byClass['vuln-db']
    const csv = regressions + allowed === 0
        ? `CSV identical${ignoreClock ? ' (ignoring clock columns)' : ''}`
        : `CSV: ${describeClasses(byClass)}`
    const ctr = pairs.length ? 'counters not compared (--pair)' : moved === 0 ? 'warm counters identical' : `${moved} warm counter(s) differ`
    const time = `largest timing change ${worst >= 0 ? '+' : ''}${worst.toFixed(0)}%`
    if (comparisons.length === 0) {
        console.log('VERDICT: nothing compared — no cell (or --pair) ran in both')
        return
    }
    const verdict = regressions > 0 || moved > 0 ? 'DIFFERENT' : allowed > 0 ? 'allowed differences only' : 'identical'
    console.log(`VERDICT: ${verdict} — ${csv}; ${ctr}; ${time}`)
}

try {
    main()
} catch (e) {
    console.error(`compare failed: ${(e as Error).message}`)
}
