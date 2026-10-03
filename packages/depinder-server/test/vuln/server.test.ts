import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {FastifyInstance} from 'fastify'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {nullLogger} from '../../src/shared/log.js'
import type {VulnConfig} from '../../src/vuln/config.js'
import {createDatabaseInfo} from '../../src/vuln/databases.js'
import {createScanLimiter, type ScanLimiter} from '../../src/vuln/limiter.js'
import {buildVulnerabilityIndex, type GrypeReport, type TrivyReport} from '../../src/vuln/merge/index.js'
import type {ScanDirs, ScannerName, ScanReports} from '../../src/vuln/scanners.js'
import {createVulnServer, type RunScan} from '../../src/vuln/server.js'
import {createFrozenSource, createManagedSource, type ToolHealth} from '../../src/vuln/source.js'
import {createStore, type Store} from '../../src/vuln/store.js'

/**
 * The route end to end, with the two scanners replaced by shell scripts that print a fixture,
 * fail, hang or print garbage. The fixtures are real Trivy 0.74 / Grype 0.118 output from Phase 0
 * for three packages, refs renamed to c0..c2 — so the purls below must be sent in this order.
 *
 * Frozen mode reads two fixed folders; managed mode leases builds from a real store on disk.
 */

const TOKEN = 'test-token-'.padEnd(20, 'x')
const auth = {authorization: `Bearer ${TOKEN}`}

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url))
const TRIVY_FIXTURE = join(FIXTURES, 'vuln-trivy.json')
const GRYPE_FIXTURE = join(FIXTURES, 'vuln-grype.json')

/** The clock every frozen source here reads: the fixture builds are ~10 h and ~13.5 h old. */
const NOW = Date.parse('2026-10-01T20:00:00Z')
const TRIVY_BUILD = {built_at: '2026-10-01T10:04:05.794145908Z', schema: '2', age_seconds: 35754, stale: false}
const GRYPE_BUILD = {built_at: '2026-10-01T06:33:48Z', schema: 'v6.1.9', age_seconds: 48372, stale: false}

const BABEL = 'pkg:npm/%40babel/core@7.12.9'
const COMMONS_LANG = 'pkg:maven/commons-lang/commons-lang@2.6?type=jar'
const X_MOD = 'pkg:golang/golang.org/x/mod@v0.37.0'
const SCANNED = [BABEL, COMMONS_LANG, X_MOD]

/**
 * The stub scanners answer in milliseconds, but a loaded machine (the whole suite running beside
 * this file) can take over a second just to start the shells. So scans get a deadline no stub ever
 * meets by accident; only the test that waits for a scan to be killed sets a short one.
 */
const SCAN_TIMEOUT_MS = 30_000
const SHORT_SCAN_TIMEOUT_MS = 1000
// Room for a test that runs five scans in a row on that machine: vitest's default is 5 s.
vi.setConfig({testTimeout: 60_000})

let root: string
/** Where every server under test puts its scan folders; must be empty after each request. */
let scanTmp: string
let okDbs: {trivy: string, grype: string}
let emptyDbs: {trivy: string, grype: string}
const bins: Record<string, string> = {}
const apps: FastifyInstance[] = []

async function script(name: string, body: string): Promise<string> {
    const path = join(root, 'bin', name)
    // `version` and `db status` are what the grype stubs are asked besides a scan.
    await writeFile(path, `#!/bin/sh
case "$1" in
  version) echo '{"version":"0.118.0"}'; exit 0;;
  db) echo '{"schemaVersion":"v6.1.9","built":"2026-10-01T06:33:48Z","valid":true}'; exit 0;;
esac
echo "$@" > "${root}/${name}.args"
${body}
`, {mode: 0o755})
    return path
}

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vuln-server-test-'))
    scanTmp = join(root, 'tmp')
    await mkdir(scanTmp)
    await mkdir(join(root, 'bin'))

    okDbs = {trivy: join(root, 'db', 'trivy'), grype: join(root, 'db', 'grype')}
    await mkdir(join(okDbs.trivy, 'db'), {recursive: true})
    await mkdir(join(okDbs.grype, '6'), {recursive: true})
    await writeFile(join(okDbs.trivy, 'db', 'metadata.json'), JSON.stringify({Version: 2, UpdatedAt: '2026-10-01T10:04:05.794145908Z'}))
    await writeFile(join(okDbs.trivy, 'db', 'trivy.db'), '')
    await writeFile(join(okDbs.grype, '6', 'vulnerability.db'), '')
    emptyDbs = {trivy: join(root, 'empty', 'trivy'), grype: join(root, 'empty', 'grype')}
    await mkdir(emptyDbs.trivy, {recursive: true})
    await mkdir(emptyDbs.grype, {recursive: true})

    bins.trivyOk = await script('trivy-ok', `cat '${TRIVY_FIXTURE}'`)
    bins.grypeOk = await script('grype-ok', `cat '${GRYPE_FIXTURE}'`)
    bins.trivyFail = await script('trivy-fail', `echo 'INFO starting' >&2; echo 'FATAL failed to load the vulnerability db: boom' >&2; echo 'bye' >&2; exit 1`)
    bins.grypeFail = await script('grype-fail', `printf '\\033[31mERROR\\033[0m unable to load vulnerability store\\n' >&2; exit 1`)
    // `exec`, so the SIGKILL reaches the process holding stdout open and not only the shell.
    bins.trivySlow = await script('trivy-slow', 'exec sleep 30')
    bins.trivyJunk = await script('trivy-junk', 'echo not json')
    bins.grypeShape = await script('grype-shape', `echo '{"matches": "none"}'`)
    // Says which database folder it was pointed at, which for Grype is only in its environment.
    bins.grypeEnv = await script('grype-env', `echo "$GRYPE_DB_CACHE_DIR" > '${root}/grype-env.dir'; cat '${GRYPE_FIXTURE}'`)
})

afterEach(async () => {
    // Every scan removes its folder, whatever happened to it.
    expect(await readdir(scanTmp)).toEqual([])
    while (apps.length > 0) await apps.pop()!.close()
})

afterAll(async () => {
    await rm(root, {recursive: true, force: true})
})

async function server(options: {
    trivyBin?: string
    grypeBin?: string
    dbs?: {trivy: string, grype: string}
    maxScans?: number
    maxQueued?: number
    maxPurls?: number
    scanTimeoutMs?: number
    now?: number
} = {}): Promise<{app: FastifyInstance, limiter: ScanLimiter}> {
    const dbs = options.dbs ?? okDbs
    const config: VulnConfig = {
        ...configBase(),
        mode: 'frozen',
        port: 0,
        logLevel: 'error',
        trivyBin: options.trivyBin ?? bins.trivyOk!,
        grypeBin: options.grypeBin ?? bins.grypeOk!,
        trivyCacheDir: dbs.trivy,
        grypeDbCacheDir: dbs.grype,
        maxPurls: options.maxPurls ?? 100,
        maxScans: options.maxScans ?? 2,
        maxQueued: options.maxQueued ?? 2,
        scanTimeoutMs: options.scanTimeoutMs ?? SCAN_TIMEOUT_MS,
    }
    const limiter = createScanLimiter(config.maxScans, config.maxQueued)
    const app = await createVulnServer({
        config,
        log: nullLogger,
        limiter,
        source: createFrozenSource(createDatabaseInfo({...config, trivyCacheDir: dbs.trivy, grypeDbCacheDir: dbs.grype}), dbs,
            {trivy: 24, grype: 72}, () => options.now ?? NOW),
        versions: {trivy: '0.74.0', grype: '0.118.0'},
    })
    await app.ready()
    apps.push(app)
    return {app, limiter}
}

function configBase(): Omit<VulnConfig, 'mode'> {
    return {
        apiToken: TOKEN,
        port: 0,
        logLevel: 'error',
        trivyBin: bins.trivyOk!,
        grypeBin: bins.grypeOk!,
        maxPurls: 100,
        maxScans: 2,
        maxQueued: 2,
        scanTimeoutMs: SCAN_TIMEOUT_MS,
        tmpDir: scanTmp,
        trivyStaleHours: 24,
        grypeStaleHours: 72,
        checkIntervalMin: 30,
        downloadTimeoutMs: 900_000,
        trivyDbRepository: 'mirror.gcr.io/aquasec/trivy-db:2',
        grypeDbUpdateUrl: 'https://grype.anchore.io/databases/v6/latest.json',
    }
}

function post(app: FastifyInstance, purls: unknown, headers: Record<string, string> = auth) {
    return app.inject({method: 'POST', url: '/vulnerabilities', headers, payload: {purls}})
}

describe('POST /vulnerabilities', () => {
    it('answers with findings keyed by the purls as sent, unsupported ones, and what produced them', async () => {
        const {app} = await server()
        const response = await post(app, [...SCANNED, 'pkg:npm/lodash', BABEL, 'pkg:github/actions/checkout@v4', 'nope'])
        expect(response.statusCode).toBe(200)
        const body = response.json() as Record<string, unknown>
        expect(Object.keys(body)).toEqual(['vulnerabilities', 'unsupported', 'databases', 'scanners'])

        const trivy = JSON.parse(await readFile(TRIVY_FIXTURE, 'utf8')) as TrivyReport
        const grype = JSON.parse(await readFile(GRYPE_FIXTURE, 'utf8')) as GrypeReport
        const expected = buildVulnerabilityIndex(trivy, grype, new Map(SCANNED.map((p, i) => [`c${i}`, p]))).index
        expect(body.vulnerabilities).toEqual(JSON.parse(JSON.stringify(Object.fromEntries(expected))))
        expect(Object.keys(body.vulnerabilities as object).sort()).toEqual([...SCANNED].sort())

        // The CVE both tools report is one finding.
        const babel = (body.vulnerabilities as Record<string, {source: string, identifiers: {value: string}[]}[]>)[BABEL]!
        expect(babel).toHaveLength(1)
        expect(babel[0]!.source).toBe('trivy,grype')
        expect(babel[0]!.identifiers.map(i => i.value)).toEqual(expect.arrayContaining(['CVE-2026-49356', 'GHSA-4x5r-pxfx-6jf8']))

        expect(body.unsupported).toEqual([
            {purl: 'pkg:npm/lodash', reason: 'no_version'},
            {purl: 'pkg:github/actions/checkout@v4', reason: 'unsupported_type'},
            {purl: 'nope', reason: 'invalid'},
        ])
        expect(body.databases).toEqual({trivy: TRIVY_BUILD, grype: GRYPE_BUILD})
        expect(body.scanners).toEqual({trivy: '0.74.0', grype: '0.118.0'})

        // Phase 0's flags, and the SBOM path, reached both scanners.
        const trivyArgs = (await readFile(join(root, 'trivy-ok.args'), 'utf8')).trim()
        expect(trivyArgs).toMatch(new RegExp(`^sbom --quiet --format json --skip-db-update --cache-dir ${okDbs.trivy} ${scanTmp}/depinder-vuln-[^/]+/sbom.json$`))
        const grypeArgs = (await readFile(join(root, 'grype-ok.args'), 'utf8')).trim()
        expect(grypeArgs).toMatch(new RegExp(`^-q sbom:${scanTmp}/depinder-vuln-[^/]+/sbom.json -o json$`))
    })

    it('answers at once, with no scan, when nothing can be scanned', async () => {
        const {app} = await server({trivyBin: bins.trivySlow})
        const response = await post(app, ['pkg:npm/lodash'])
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({vulnerabilities: {}, unsupported: [{purl: 'pkg:npm/lodash', reason: 'no_version'}]})
    })

    it('needs the token', async () => {
        const {app} = await server()
        expect((await post(app, SCANNED, {})).statusCode).toBe(401)
        expect((await post(app, SCANNED, {authorization: 'Bearer wrong-token-wrong-token'})).statusCode).toBe(401)
    })

    it('refuses a malformed body with a 400', async () => {
        const {app} = await server()
        expect((await post(app, 'pkg:npm/a@1')).statusCode).toBe(400)
        const response = await app.inject({method: 'POST', url: '/vulnerabilities', headers: auth, payload: {}})
        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({error: '"purls" must be an array of strings'})
    })

    it('refuses more distinct purls than allowed with a 413 that says the limit', async () => {
        const {app} = await server({maxPurls: 3})
        expect((await post(app, [...SCANNED, ...SCANNED])).statusCode).toBe(200)
        const response = await post(app, [...SCANNED, 'pkg:npm/one-more@1'])
        expect(response.statusCode).toBe(413)
        expect(response.json()).toEqual({error: 'at most 3 distinct purls per request', max: 3})
    })

    it('answers 503 busy, with Retry-After, when every slot is taken and the line is full', async () => {
        const {app, limiter} = await server({trivyBin: bins.trivySlow, maxScans: 1, maxQueued: 0,
            scanTimeoutMs: SHORT_SCAN_TIMEOUT_MS})
        const first = post(app, SCANNED)
        while (limiter.stats().running === 0) await new Promise(r => setTimeout(r, 10))

        const busy = await post(app, SCANNED)
        expect(busy.statusCode).toBe(503)
        expect(busy.headers['retry-after']).toBe('1')
        expect(busy.json()).toEqual({error: 'busy'})

        // The slow one is killed at its deadline.
        const timedOut = await first
        expect(timedOut.statusCode).toBe(500)
        expect(timedOut.json()).toEqual({error: 'scan failed', scanner: 'trivy', reason: 'timeout'})
        expect(limiter.stats()).toEqual({running: 0, queued: 0})
    })

    it('answers 503 while the databases are not there', async () => {
        const {app} = await server({dbs: emptyDbs})
        const response = await post(app, SCANNED)
        expect(response.statusCode).toBe(503)
        expect(response.json()).toMatchObject({error: 'databases not ready'})
        expect((response.json() as {reason: string}).reason).toContain('trivy.db')
    })

    it('answers 500 with the scanner and the reason when a scan fails', async () => {
        const cases: [Parameters<typeof server>[0], {scanner: string, reason: string | RegExp}][] = [
            [{trivyBin: bins.trivyFail}, {scanner: 'trivy', reason: 'exit 1 — FATAL failed to load the vulnerability db: boom'}],
            [{grypeBin: bins.grypeFail}, {scanner: 'grype', reason: 'exit 1 — ERROR unable to load vulnerability store'}],
            [{trivyBin: bins.trivyJunk}, {scanner: 'trivy', reason: 'unparseable output'}],
            [{grypeBin: bins.grypeShape}, {scanner: 'grype', reason: 'unparseable output'}],
            [{trivyBin: join(root, 'bin', 'missing')}, {scanner: 'trivy', reason: /^spawn failed: .*ENOENT/}],
        ]
        for (const [options, expected] of cases) {
            const {app} = await server(options)
            const response = await post(app, SCANNED)
            expect(response.statusCode).toBe(500)
            const body = response.json() as {error: string, scanner: string, reason: string}
            expect(body.error).toBe('scan failed')
            expect(body.scanner).toBe(expected.scanner)
            if (typeof expected.reason === 'string') expect(body.reason).toBe(expected.reason)
            else expect(body.reason).toMatch(expected.reason)
            expect(await readdir(scanTmp)).toEqual([])
        }
    })
})

describe('GET /health', () => {
    it('answers without a token, with the scans and the databases', async () => {
        const {app} = await server()
        const response = await app.inject({method: 'GET', url: '/health'})
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
            status: 'ok',
            scans: {running: 0, queued: 0},
            databases: {trivy: TRIVY_BUILD, grype: GRYPE_BUILD},
        })
    })

    it('stays a 200 when a build is stale, says so, and the scans go on with it', async () => {
        // Two days on: Trivy (24 h) is stale, Grype (72 h) is not yet.
        const {app} = await server({now: NOW + 48 * 3600_000})
        const response = await app.inject({method: 'GET', url: '/health'})
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({
            status: 'stale',
            databases: {trivy: {stale: true, age_seconds: 35754 + 48 * 3600}, grype: {stale: false}},
        })
        const scan = await post(app, SCANNED)
        expect(scan.statusCode).toBe(200)
        expect(scan.json()).toMatchObject({databases: {trivy: {stale: true}, grype: {stale: false}}})
    })

    it('is a 503 while the databases are not there', async () => {
        const {app} = await server({dbs: emptyDbs})
        const response = await app.inject({method: 'GET', url: '/health'})
        expect(response.statusCode).toBe(503)
        expect(response.json()).toMatchObject({status: 'not_ready'})
        expect((response.json() as {reason: string}).reason).toContain('trivy.db')
    })
})

describe('managed mode', () => {
    let dataDir: string
    let store: Store

    beforeAll(async () => {
        dataDir = join(root, 'managed')
    })

    afterEach(async () => {
        await rm(dataDir, {recursive: true, force: true})
    })

    async function openStore(): Promise<Store> {
        store = createStore({dataDir, staleHours: {trivy: 24, grype: 72}, log: nullLogger, now: () => NOW})
        await store.open()
        return store
    }

    async function install(tool: ScannerName, built_at: string): Promise<void> {
        const dir = await store.newStaging(tool)
        if (tool === 'trivy') {
            await mkdir(join(dir, 'db'))
            await writeFile(join(dir, 'db', 'trivy.db'), '')
            await writeFile(join(dir, 'db', 'metadata.json'), '{}')
        } else {
            await mkdir(join(dir, '6'))
            await writeFile(join(dir, '6', 'vulnerability.db'), '')
        }
        await store.install(tool, dir, {tool, built_at, schema: tool === 'trivy' ? '2' : 'v6.1.9', upstream_id: null,
            canary_findings: null, installed_at: built_at})
    }

    async function managedServer(options: {
        runScan?: RunScan
        grypeBin?: string
        status?: Partial<Record<ScannerName, Partial<ToolHealth>>>
    } = {}): Promise<FastifyInstance> {
        const config: VulnConfig = {...configBase(), mode: 'managed', dataDir, grypeBin: options.grypeBin ?? bins.grypeOk!}
        const app = await createVulnServer({
            config,
            log: nullLogger,
            limiter: createScanLimiter(2, 2),
            source: createManagedSource(store, tool => options.status?.[tool] ?? {}, {trivy: 24, grype: 72}, () => NOW),
            versions: {trivy: '0.74.0', grype: '0.118.0'},
            runScan: options.runScan,
        })
        await app.ready()
        apps.push(app)
        return app
    }

    it('scans with the folders of the leased builds', async () => {
        await openStore()
        await install('trivy', TRIVY_BUILD.built_at)
        await install('grype', GRYPE_BUILD.built_at)
        const app = await managedServer({grypeBin: bins.grypeEnv})
        const response = await post(app, SCANNED)
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({databases: {trivy: TRIVY_BUILD, grype: GRYPE_BUILD}})

        const trivyArgs = (await readFile(join(root, 'trivy-ok.args'), 'utf8')).trim()
        expect(trivyArgs).toContain(`--cache-dir ${join(dataDir, 'trivy', '2026-10-01T100405.794145908Z')} `)
        expect((await readFile(join(root, 'grype-env.dir'), 'utf8')).trim()).toBe(join(dataDir, 'grype', '2026-10-01T063348Z'))
        expect(store.builds().every(b => b.refs === 0)).toBe(true)
    })

    it('is a 503 naming the tool that is still downloading, and /health shows what each tool is doing', async () => {
        await openStore()
        await install('trivy', TRIVY_BUILD.built_at)
        const status = {grype: {updating: true, last_error: null, last_check_at: '2026-10-01T19:59:59.000Z'}}
        const app = await managedServer({status})

        const response = await post(app, SCANNED)
        expect(response.statusCode).toBe(503)
        expect(response.json()).toEqual({error: 'databases not ready', reason: 'grype: downloading'})

        const health = await app.inject({method: 'GET', url: '/health'})
        expect(health.statusCode).toBe(503)
        expect(health.json()).toEqual({
            status: 'not_ready',
            reason: 'grype: downloading',
            databases: {trivy: TRIVY_BUILD, grype: status.grype},
        })
    })

    it('stays a 200 on /health with a stale build and the last error, and keeps scanning', async () => {
        await openStore()
        await install('trivy', '2026-09-29T10:00:00Z')
        await install('grype', GRYPE_BUILD.built_at)
        const app = await managedServer({status: {trivy: {last_error: 'check failed: HTTP 404', updating: false}}})
        const health = await app.inject({method: 'GET', url: '/health'})
        expect(health.statusCode).toBe(200)
        expect(health.json()).toMatchObject({
            status: 'stale',
            databases: {trivy: {stale: true, last_error: 'check failed: HTTP 404'}, grype: {stale: false}},
        })
        expect((await post(app, SCANNED)).statusCode).toBe(200)
    })

    it('answers a request with the build it started on when a new one is installed during its scan', async () => {
        await openStore()
        await install('trivy', TRIVY_BUILD.built_at)
        await install('grype', GRYPE_BUILD.built_at)
        const reports: ScanReports = {
            trivy: JSON.parse(await readFile(TRIVY_FIXTURE, 'utf8')) as TrivyReport,
            grype: JSON.parse(await readFile(GRYPE_FIXTURE, 'utf8')) as GrypeReport,
            trivyMs: 1,
            grypeMs: 1,
        }
        const seen: ScanDirs[] = []
        let unblock: (() => void) | undefined
        const app = await managedServer({
            runScan: async (_sbom, dirs) => {
                seen.push(dirs)
                if (seen.length === 1) await new Promise<void>(r => {
                    unblock = r
                })
                return reports
            },
        })

        const first = post(app, SCANNED)
        while (!unblock) await new Promise(r => setTimeout(r, 5))
        const oldDir = seen[0]!.trivy
        await install('trivy', '2026-10-01T19:00:16.340316472Z')

        // The old build stays on disk while the scan reading it runs.
        expect(await readdir(join(dataDir, 'trivy'))).toHaveLength(2)
        const second = await post(app, SCANNED)
        expect(second.json()).toMatchObject({databases: {trivy: {built_at: '2026-10-01T19:00:16.340316472Z'}}})
        expect(seen[1]!.trivy).toBe(join(dataDir, 'trivy', '2026-10-01T190016.340316472Z'))

        unblock()
        const answered = await first
        expect(answered.statusCode).toBe(200)
        expect(answered.json()).toMatchObject({databases: {trivy: TRIVY_BUILD, grype: GRYPE_BUILD}})
        // Released with the answer, and deleted with the release.
        await store.settled()
        expect(await readdir(join(dataDir, 'trivy'))).toEqual(['2026-10-01T190016.340316472Z'])
        expect(oldDir).toBe(join(dataDir, 'trivy', '2026-10-01T100405.794145908Z'))
    })
})
