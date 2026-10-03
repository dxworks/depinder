import {appendFileSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {parseArgs} from 'node:util'
import {byStatus, counts, fetchedIn, formatCounts, isDrained, openDb, type BenchDb} from './lib/db.js'
import {depinderPreflight, EXPECTED_BRANCH, gitInfo, runDepinder} from './lib/depinder.js'
import {apiToken, maskedDbHost, readEnvFile, scrubDbDetails} from './lib/env.js'
import {imageCreated, imageStaleness, stackUp, waitHealthy} from './lib/stack.js'
import {buildSummary, CELLS, describeVulnDbs, type Cell, type RunRecord, type ServerStats} from './lib/summary.js'
import {INPUT_DIR, MONOREPO_DIR, resolveTarget, RUNS_DIR, type Target} from './lib/targets.js'
import {checkWipeAllowed, confirmWipe, wipe} from './lib/wipe.js'

/**
 * The end-to-end benchmark: depinder against the resolver and vuln server, per producer, in four
 * cells — empty server, warm server with a cold local cache, both warm, and no server at all
 * (depinder's own registry fallback). See bench/README.md.
 *
 *   npm run bench -- [--target dev|deploy|hosted] [--producers trivy,syft]
 *                    [--cells empty,warm-server,warm-both,no-server] [--repeats 3] [--label name] [--now ISO]
 *                    [--yes] [--allow-wipe-nondev] [--keep-caches] [--rebuild] [--build-depinder]
 *                    [--drain-timeout-min 20] [--run-timeout-min 45]
 */

const USAGE = 'usage: npm run bench -- [--target dev|deploy|hosted] [--producers trivy,syft] '
    + '[--cells empty,warm-server,warm-both,no-server] [--repeats N] [--label name] [--now ISO] [--yes] '
    + '[--allow-wipe-nondev] [--keep-caches] [--rebuild] [--build-depinder] [--drain-timeout-min N] [--run-timeout-min N]'

/** What depinder accepts in DEPINDER_REPORT_NOW: a date, optionally with a time and an offset. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** The fixed date every depinder run of this bench measures ages from: `--now`, else the bench's start. */
function reportNowOption(raw: string | undefined): string {
    if (raw === undefined) return new Date().toISOString()
    if (!ISO_DATE_TIME.test(raw) || Number.isNaN(new Date(raw).getTime())) {
        throw new Error(`--now ${raw} is not an ISO 8601 date (e.g. 2026-10-03 or 2026-10-03T14:30:00.000Z)`)
    }
    return raw
}

interface Options {
    target: string
    producers: string[]
    cells: Cell[]
    repeats: number
    label: string
    /** ISO date passed to every depinder run as DEPINDER_REPORT_NOW. */
    now: string
    yes: boolean
    allowWipeNondev: boolean
    keepCaches: boolean
    rebuild: boolean
    buildDepinder: boolean
    drainTimeoutMin: number
    runTimeoutMin: number
}

function parseOptions(): Options {
    const {values} = parseArgs({options: {
        'target': {type: 'string', default: 'dev'},
        'producers': {type: 'string', default: 'trivy,syft'},
        'cells': {type: 'string', default: CELLS.join(',')},
        'repeats': {type: 'string', default: '3'},
        'label': {type: 'string', default: 'run'},
        'now': {type: 'string'},
        'yes': {type: 'boolean', default: false},
        'allow-wipe-nondev': {type: 'boolean', default: false},
        'keep-caches': {type: 'boolean', default: false},
        'rebuild': {type: 'boolean', default: false},
        'build-depinder': {type: 'boolean', default: false},
        'drain-timeout-min': {type: 'string', default: '20'},
        'run-timeout-min': {type: 'string', default: '45'},
        'help': {type: 'boolean', default: false},
    }})
    if (values.help) { console.log(USAGE); process.exit(0) }
    const list = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)
    const asked = list(values.cells)
    for (const c of asked) if (!CELLS.includes(c as Cell)) throw new Error(`unknown cell "${c}" (one of ${CELLS.join(', ')})`)
    // Always in this order, whatever order they were given in: each cell needs what the one before left.
    const cells = CELLS.filter(c => asked.includes(c))
    if (cells.includes('warm-both') && !cells.includes('warm-server')) {
        throw new Error('warm-both reruns on the caches warm-server leaves: add warm-server to --cells')
    }
    const repeats = Number(values.repeats)
    if (!Number.isInteger(repeats) || repeats < 1) throw new Error('--repeats must be a whole number >= 1')
    const drainTimeoutMin = Number(values['drain-timeout-min'])
    const runTimeoutMin = Number(values['run-timeout-min'])
    if (!(drainTimeoutMin > 0) || !(runTimeoutMin > 0)) throw new Error('--drain-timeout-min and --run-timeout-min must be numbers > 0')
    if (!/^[\w.-]+$/.test(values.label)) throw new Error('--label may hold letters, digits, ".", "_" and "-" only')
    return {
        target: values.target, producers: list(values.producers), cells, repeats, label: values.label, now: reportNowOption(values.now),
        yes: values.yes, allowWipeNondev: values['allow-wipe-nondev'], keepCaches: values['keep-caches'],
        rebuild: values.rebuild, buildDepinder: values['build-depinder'], drainTimeoutMin, runTimeoutMin,
    }
}

interface Ctx {
    opts: Options
    target: Target
    token: string
    host: string
    db: BenchDb
    runDir: string
    records: RunRecord[]
    loads: {id: string, before: number[], after: number[]}[]
    strippedEnv: string[]
    /** Masks the database's host and user in a driver error before it is printed. */
    scrub: (message: string) => string
}

function stamp(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

/** One depinder run of one cell, recorded in results.jsonl as soon as it ends. */
async function runOne(ctx: Ctx, cell: Cell, producer: string, repeat: number | null, cache: string, fresh: boolean): Promise<RunRecord> {
    const id = repeat === null ? `${cell}-${producer}` : `${cell}-${producer}-${repeat}`
    console.log(`  ${id}: running (${fresh ? 'empty' : 'warm'} local cache) ...`)
    const res = await runDepinder({
        producer, url: ctx.target.url, token: ctx.token, cacheDb: cache, freshCache: fresh, cwd: ctx.runDir,
        timeoutMs: ctx.opts.runTimeoutMin * 60_000, resolver: cell !== 'no-server', reportNow: ctx.opts.now,
        outDir: path.join(ctx.runDir, 'out', id), logFile: path.join(ctx.runDir, 'logs', `${id}.log`),
    })
    ctx.strippedEnv = res.strippedEnv
    const p = res.picks
    console.log(`  ${id}: ${res.timedOut ? 'KILLED (timeout)' : `exit ${res.code}`}, ${res.wall.toFixed(1)} s (resolve:bulk ${p.bulk?.toFixed(1) ?? '-'} s, registry:fetch ${p.registryFetch})`
        + (res.profile ? '' : ' — NO PROFILE BLOCK in the log'))
    const record: RunRecord = {
        id, cell, producer, repeat, start: res.start.toISOString(), end: res.end.toISOString(), wall: res.wall, code: res.code, timedOut: res.timedOut,
        loadBefore: res.loadBefore, loadAfter: res.loadAfter, picks: p,
        phases: res.profile?.phases ?? {}, counters: res.profile?.counters ?? {},
    }
    ctx.loads.push({id, before: res.loadBefore, after: res.loadAfter})
    return record
}

function save(ctx: Ctx, record: RunRecord): void {
    ctx.records.push(record)
    appendFileSync(path.join(ctx.runDir, 'results.jsonl'), JSON.stringify(record) + '\n')
}

/**
 * Polls until nothing is pending and the queue is empty. A failed poll is a lost sample, not an
 * error: a filling worker can take every slot the session pooler has.
 */
async function waitDrain(db: BenchDb, timeoutMs: number, scrub: (message: string) => string): Promise<number | null> {
    const started = Date.now()
    let lastLine = 0
    for (;;) {
        try {
            const d = await isDrained(db)
            if (d.drained) return (Date.now() - started) / 1000
            if (Date.now() - lastLine > 30_000) {
                console.log(`    draining: pending=${d.pending} queued=${d.queued} (${Math.round((Date.now() - started) / 1000)} s)`)
                lastLine = Date.now()
            }
        } catch (e) {
            console.log(`    (no database sample: ${scrub((e as Error).message).slice(0, 80)})`)
        }
        if (Date.now() - started > timeoutMs) return null
        await sleep(10_000)
    }
}

async function emptyCell(ctx: Ctx, producer: string): Promise<void> {
    await wipe(ctx.target, ctx.host, ctx.db)
    const record = await runOne(ctx, 'empty', producer, null, path.join(ctx.runDir, 'caches', `empty-${producer}.sqlite`), true)
    const window = {start: new Date(record.start), end: new Date(record.end)}
    const statusAtEnd = await byStatus(ctx.db)
    const inWindow = await fetchedIn(ctx.db, window)
    console.log(`    server fetched ${inWindow.total} package(s) while depinder ran; waiting for the queue to drain`)
    const drainSeconds = await waitDrain(ctx.db, ctx.opts.drainTimeoutMin * 60_000, ctx.scrub)
    const drainEnd = new Date()
    const server: ServerStats = {
        window: inWindow,
        untilDrain: await fetchedIn(ctx.db, {start: window.start, end: drainEnd}),
        drainSeconds, drainTimedOut: drainSeconds === null,
        statusAtEnd, statusAfterDrain: await byStatus(ctx.db),
    }
    console.log(drainSeconds === null
        ? `    drain TIMED OUT after ${ctx.opts.drainTimeoutMin} min; the warm cells run on a server still filling`
        : `    drained ${drainSeconds.toFixed(0)} s after depinder exited; ${server.untilDrain?.total} fetched in all`)
    save(ctx, {...record, server})
}

async function producerCells(ctx: Ctx, producer: string): Promise<void> {
    console.log(`\n== ${producer}`)
    const cache = (i: number) => path.join(ctx.runDir, 'caches', `warm-server-${producer}-${i}.sqlite`)
    if (ctx.opts.cells.includes('empty')) await emptyCell(ctx, producer)
    for (let i = 1; ctx.opts.cells.includes('warm-server') && i <= ctx.opts.repeats; i++) {
        save(ctx, await runOne(ctx, 'warm-server', producer, i, cache(i), true))
    }
    // Repeat i reruns on the cache warm-server repeat i left: local SQLite warm, server warm.
    for (let i = 1; ctx.opts.cells.includes('warm-both') && i <= ctx.opts.repeats; i++) {
        save(ctx, await runOne(ctx, 'warm-both', producer, i, cache(i), false))
    }
    // No resolver and an empty local cache: every package goes through depinder's own fallback.
    const noServerCache = (i: number) => path.join(ctx.runDir, 'caches', `no-server-${producer}-${i}.sqlite`)
    for (let i = 1; ctx.opts.cells.includes('no-server') && i <= ctx.opts.repeats; i++) {
        save(ctx, await runOne(ctx, 'no-server', producer, i, noServerCache(i), true))
    }
}

/** Without the empty cell, a warm cell on a server that is empty or still filling would be a cold one. */
async function requireFilled(db: BenchDb, host: string): Promise<void> {
    const c = await counts(db)
    if (c.packages === 0 || c.pending > 0 || c.queued > 0) {
        throw new Error(`the warm cells need a filled, drained server, and the ${host} has ${formatCounts(c)}. `
            + 'Add empty to --cells (wipes and fills it), or wait until pending and queued are 0.')
    }
}

async function main(): Promise<void> {
    const opts = parseOptions()
    const target = resolveTarget(opts.target)
    const env = readEnvFile(target.envFile, target.envRaw)
    const token = apiToken(env, target.envFile)
    const host = maskedDbHost(target.name, env.DATABASE_URL)
    const scrub = (message: string) => scrubDbDetails(message, env.DATABASE_URL)
    const wiping = opts.cells.includes('empty')
    if (wiping) checkWipeAllowed(target, {yes: opts.yes, allowNonDev: opts.allowWipeNondev})
    console.log(`Bench "${opts.label}": target ${target.name} (${target.url}), ${host}, `
        + `producers ${opts.producers.join(',')}, cells ${opts.cells.join(',')}, repeats ${opts.repeats}`)
    console.log(`Ages measured from ${opts.now} (DEPINDER_REPORT_NOW in every depinder run)`)

    for (const w of depinderPreflight(opts.buildDepinder)) console.warn(`WARNING: ${w}`)
    const db = openDb(env)
    try {
        // Before the stack: with credentials the database refuses, the resolver never gets healthy,
        // and the health wait would only say so after ten minutes.
        await db.query('select 1').catch((e: Error) => {
            throw new Error(`cannot reach the ${host} with ${target.envFile}: ${scrub(e.message)}`)
        })
        stackUp(target, opts.rebuild)
        const vulnHealth = await waitHealthy(target)
        const created = imageCreated(target)
        const stale = imageStaleness(created)
        if (stale) console.warn(`WARNING: ${stale}`)

        if (wiping) {
            if (!await confirmWipe(target, host, db, {yes: opts.yes, allowNonDev: opts.allowWipeNondev}, `This bench (once per producer)`)) {
                throw new Error('not confirmed; nothing was changed')
            }
        } else if (opts.cells.includes('warm-server')) {
            await requireFilled(db, host)
        }
        const runDir = path.join(RUNS_DIR, `${stamp()}-${opts.label}`)
        mkdirSync(runDir, {recursive: true})
        const ctx: Ctx = {opts, target, token, host, db, runDir, records: [], loads: [], strippedEnv: [], scrub}
        // CLI and server share the monorepo; run.json keeps both keys so older runs still compare.
        const depinder = gitInfo(MONOREPO_DIR)
        const server = depinder
        const runStarted = new Date()
        const meta = (finished: boolean) => ({
            label: opts.label, target: target.name, url: target.url, dbHost: host,
            depinder: {...depinder, dir: MONOREPO_DIR, expectedBranch: EXPECTED_BRANCH}, server,
            imageCreated: created, imageWarning: stale, vulnHealth: vulnHealth.body, inputDir: INPUT_DIR,
            node: process.version, host: os.hostname(), cpus: os.cpus().length,
            ghTokensStripped: true, strippedEnv: ctx.strippedEnv, loads: ctx.loads, options: opts, reportNow: opts.now,
            startedAt: runStarted.toISOString(), finishedAt: finished ? new Date().toISOString() : null,
        })
        writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(meta(false), null, 2))
        console.log(`Run folder: ${runDir}`)

        // Whatever happens, the runs that finished get their summary and the caches go.
        let failure: Error | null = null
        try {
            for (const producer of opts.producers) await producerCells(ctx, producer)
        } catch (e) {
            failure = e as Error
        }
        writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({...meta(true), error: failure?.message ?? null}, null, 2))
        const summary = buildSummary({
            label: opts.label, target: target.name, url: target.url, dbHost: host, depinderSha: depinder.sha,
            serverSha: server.sha, imageCreated: created, vulnDbs: describeVulnDbs(vulnHealth.body), reportNow: opts.now,
        }, ctx.records) + (failure ? `\n\n**INCOMPLETE**: the bench stopped with: ${failure.message}` : '')
        writeFileSync(path.join(runDir, 'summary.md'), summary + '\n')
        if (!opts.keepCaches) rmSync(path.join(runDir, 'caches'), {recursive: true, force: true})
        console.log(`\n${summary}\n\nRun folder: ${runDir}`)
        console.log(`Every later run compared with this one must measure ages from the same date: add --now ${opts.now}`)
        if (failure) throw failure
    } finally {
        await db.end()
    }
}

main().catch(e => {
    console.error(`bench failed: ${(e as Error).message}`)
    process.exitCode = 1
})
