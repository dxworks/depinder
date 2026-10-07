import type {FetchedInWindow} from './db.js'
import {ECOSYSTEM_TO_TYPE, median, type Picks} from './profile.js'

/**
 * One line of results.jsonl (one depinder run), and summary.md built from them. compare.ts reads
 * the same records, so a field renamed here must be renamed there.
 */

export type Cell = 'empty' | 'warm-after-empty' | 'warm-server' | 'warm-both' | 'no-server' | 'warm-after-no-server'
/** Run order: each cell may need what an earlier one left (a filled server, a local cache). */
export const CELLS: readonly Cell[] = ['empty', 'warm-after-empty', 'warm-server', 'warm-both', 'no-server', 'warm-after-no-server']
/** Cells that run once per producer and have no repeats. */
export const ONCE_CELLS: readonly Cell[] = ['empty', 'warm-after-empty']
/** Cold then warm on the same local cache: each warm cell reruns (resolver on) on a copy of its cold cell's cache. */
export const WARM_AFTER_COLD: readonly {cold: Cell, warm: Cell}[] = [
    {cold: 'empty', warm: 'warm-after-empty'},
    {cold: 'no-server', warm: 'warm-after-no-server'},
]

/** What the server did around an empty-cell run, from its database. */
export interface ServerStats {
    /** Fetched while depinder ran. */
    window: FetchedInWindow
    /** Fetched from depinder's start until the queue drained (or the drain timed out). */
    untilDrain: FetchedInWindow | null
    /** Seconds from depinder's exit until drained; null if it timed out. */
    drainSeconds: number | null
    drainTimedOut: boolean
    statusAtEnd: Record<string, number>
    statusAfterDrain: Record<string, number> | null
}

export interface RunRecord {
    id: string
    cell: Cell
    producer: string
    /** 1..N for the repeated cells, null for the ONCE_CELLS. */
    repeat: number | null
    start: string
    end: string
    wall: number
    code: number | null
    /** Killed by --run-timeout-min. */
    timedOut?: boolean
    loadBefore: number[]
    loadAfter: number[]
    picks: Picks
    phases: Record<string, number>
    counters: Record<string, number>
    server?: ServerStats
}

const f1 = (x: number | null | undefined) => x === null || x === undefined ? '-' : Number.isInteger(x) ? String(x) : x.toFixed(1)

/** "median (min–max)" over repeats, or the single value. */
function spread(xs: (number | null)[]): string {
    const v = xs.filter((x): x is number => x !== null)
    if (v.length === 0) return '-'
    if (v.length === 1) return f1(v[0])
    return `${f1(median(v))} (${f1(Math.min(...v))}–${f1(Math.max(...v))})`
}

function table(header: string[], rows: string[][]): string[] {
    return [
        `| ${header.join(' | ')} |`,
        `|${header.map(() => '---').join('|')}|`,
        ...rows.map(r => `| ${r.join(' | ')} |`),
    ]
}

export function groupRuns(records: RunRecord[]): Map<string, RunRecord[]> {
    const groups = new Map<string, RunRecord[]>()
    for (const r of records) {
        const key = `${r.cell}/${r.producer}`
        groups.set(key, [...(groups.get(key) ?? []), r])
    }
    return groups
}

function timingTable(records: RunRecord[]): string[] {
    const rows: string[][] = []
    for (const [key, runs] of groupRuns(records)) {
        const pk = (f: (p: Picks) => number | null) => spread(runs.map(r => f(r.picks)))
        rows.push([key, String(runs.length), runs.map(r => r.code).join(','), pk(p => p.wall), pk(p => p.bulk), pk(p => p.vulnServer),
            pk(p => p.enrichMax), pk(p => p.blackduck), pk(p => p.registryFetch), pk(p => p.cacheHit), pk(p => p.cacheMiss)])
    }
    return table(['cell/producer', 'n', 'exit', 'wall s', 'resolve:bulk s', 'vuln:server s', 'max enrich:* s',
        'blackduck:* s', 'registry:fetch', 'cache:hit', 'cache:miss'], rows)
}

function emptyTable(r: RunRecord): string[] {
    const p = r.picks
    const s = r.server
    const lines = [
        `### empty / ${r.producer}`,
        '',
        `- purls asked: ${p.asked}`,
        `- server answered: resolved ${p.resolved}, not-found ${p.notFound}, refreshing ${p.refreshing}, ` +
            `pending at deadline ${p.pending}, error ${p.error}`,
        `- depinder fetched itself (registry:fetch): ${p.registryFetch}` +
            ` (pending + refreshing + error = ${p.pending + p.refreshing + p.error}); registry:error ${p.registryError}`,
        `- depinder HTTP: ${Object.entries(p.http).map(([h, n]) => `${h} ${n}`).join(', ') || '-'}`,
    ]
    if (s) {
        lines.push(
            `- server fetched (resolved/not_found): ${s.window.total} while depinder ran, ` +
                `${s.untilDrain?.total ?? '-'} by drain end`,
            `- server HTTP requests (fetch_log): ${s.window.requests} while depinder ran (${s.window.packageRequests} for packages), ` +
                `${s.untilDrain?.requests ?? '-'} by drain end (${s.untilDrain?.packageRequests ?? '-'} for packages)`,
            `- drain after depinder exited: ${s.drainTimedOut ? 'TIMED OUT' : `${f1(s.drainSeconds)} s`}`,
            `- server package rows by status at depinder exit: ${JSON.stringify(s.statusAtEnd)}; after drain: ${JSON.stringify(s.statusAfterDrain)}`,
        )
    }
    lines.push('')
    const types = new Set<string>([
        ...Object.keys(p.registryFetchBy).map(e => ECOSYSTEM_TO_TYPE[e] ?? e),
        ...Object.keys(s?.window.byType ?? {}), ...Object.keys(s?.untilDrain?.byType ?? {}),
    ])
    const fetchedBy = (type: string) => Object.entries(p.registryFetchBy)
        .filter(([e]) => (ECOSYSTEM_TO_TYPE[e] ?? e) === type).reduce((a, [, n]) => a + n, 0)
    const rows = [...types].sort().map(t => [t, String(fetchedBy(t)), String(s?.window.byType[t] ?? 0),
        s?.untilDrain ? String(s.untilDrain.byType[t] ?? 0) : '-'])
    rows.push(['**total**', String(p.registryFetch), String(s?.window.total ?? '-'), String(s?.untilDrain?.total ?? '-')])
    lines.push(...table(['type', 'depinder registry:fetch', 'server fetched in window', 'server fetched by drain end'], rows), '')
    return lines
}

/** depinder's own registry work per ecosystem in the no-server cell: lookups and enrich time. */
function noServerTable(runs: RunRecord[]): string[] {
    const producers = [...new Set(runs.map(r => r.producer))]
    const lines: string[] = []
    for (const producer of producers) {
        const mine = runs.filter(r => r.producer === producer)
        const ecosystems = [...new Set(mine.flatMap(r => Object.keys(r.picks.registryFetchBy)))].sort()
        const rows = ecosystems.map(e => [e, spread(mine.map(r => r.picks.registryFetchBy[e] ?? 0))])
        const phases = [...new Set(mine.flatMap(r => Object.keys(r.phases)).filter(k => k.startsWith('enrich:')))].sort()
        lines.push(`### no-server / ${producer}`, '',
            ...table(['ecosystem', 'registry:fetch'], rows), '',
            ...table(['phase', 'seconds'], phases.map(k => [k, spread(mine.map(r => r.phases[k] ?? null))])), '')
    }
    return lines
}

export interface SummaryHeader {
    label: string
    target: string
    url: string
    dbHost: string
    depinderSha: string | null
    serverSha: string | null
    imageCreated: string | null
    vulnDbs: string
    /** The fixed date depinder measured ages from in every run. */
    reportNow: string
}

export function buildSummary(h: SummaryHeader, records: RunRecord[]): string {
    const lines = [
        `# Bench ${h.label}`,
        '',
        `target ${h.target} (${h.url}), ${h.dbHost}; depinder ${h.depinderSha?.slice(0, 7) ?? '?'}, ` +
            `server ${h.serverSha?.slice(0, 7) ?? '?'}, image ${h.imageCreated ?? '-'}; ${h.vulnDbs}`,
        '',
        `Ages measured from ${h.reportNow}; a later run compared with this one reuses it: \`--now ${h.reportNow}\``,
        '',
        '## Timings (median (min–max) over repeats; seconds)',
        '',
        ...timingTable(records),
        '',
    ]
    const empties = records.filter(r => r.cell === 'empty')
    if (empties.length) lines.push('## Empty server', '', ...empties.flatMap(emptyTable))
    const noServer = records.filter(r => r.cell === 'no-server')
    if (noServer.length) lines.push('## No server (depinder\'s own fallback; median (min–max) over repeats)', '', ...noServerTable(noServer))
    return lines.join('\n')
}

/** The vuln server's database builds in one line, from its /health body. */
export function describeVulnDbs(body: unknown): string {
    const dbs = (body as {databases?: Record<string, {built_at?: string}>} | null)?.databases
    if (!dbs) return 'vuln DBs unknown'
    return 'vuln DBs ' + Object.entries(dbs).map(([tool, d]) => `${tool} ${d?.built_at ?? '?'}`).join(', ')
}
