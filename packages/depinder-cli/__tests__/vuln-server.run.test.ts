import type {MockInstance} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {filesForPlugin} from '../src/commands/analyse'
import {clearSbomCache, deferSbomFindings, sbomNpm} from '../src/plugins/sbom'
import {clearLocalScanCache, PROVENANCE_FILE} from '../src/plugins/sbom/local-scan'
import {DependencyFileContext} from '../src/extension-points/extract'
import {collectSbomTargets, startServerVulnerabilities, vulnSummaryLine, writeServerProvenance} from '../src/vuln-sources/run'
import {VulnServerConfig} from '../src/vuln-sources/server'
import {resetVulnSources} from '../src/vuln-sources/selection'
import {log} from '../src/utils/logging'

/**
 * Where an SBOM run's findings come from when a vulnerability server is configured: the server,
 * with no local scanner touched; or, when it fails, the local scan exactly as before. The local
 * scanners are stub shell scripts that log every call, so "not run" is observable.
 */

let tmpDir: string
let sbomFile: string
let callLog: string
const savedEnv = {TRIVY_BIN: process.env.TRIVY_BIN, GRYPE_BIN: process.env.GRYPE_BIN}
const realFetch = global.fetch
let warnSpy: MockInstance
let infoSpy: MockInstance
const warnings: string[] = []

const config: VulnServerConfig = {url: 'http://vuln.example:8080', token: 'secret', maxWaitMs: 5_000, chunkSize: 5000}

const trivyReport = {
    Results: [{
        Vulnerabilities: [{
            VulnerabilityID: 'CVE-2021-23337',
            PkgName: 'lodash',
            InstalledVersion: '4.17.15',
            PkgIdentifier: {PURL: 'pkg:npm/lodash@4.17.15'},
            Severity: 'HIGH',
        }],
    }],
}

/** A stub scanner that records every invocation in `callLog`, then answers like the real one. */
function stub(name: string, script: string): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${callLog}'\n${script}`)
    fs.chmodSync(file, 0o755)
    return file
}

const serverFinding = {
    severity: 'CRITICAL', score: 9.8, description: 'from the server', permalink: 'https://example/CVE-1',
    identifiers: [{value: 'CVE-2021-23337', type: 'CVE'}], source: 'trivy,grype', vulnerableRange: '<4.17.21',
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-vuln-run-'))
    callLog = path.join(tmpDir, 'calls.log')
    sbomFile = path.join(tmpDir, 'web.cdx.json')
    fs.writeFileSync(sbomFile, JSON.stringify({
        bomFormat: 'CycloneDX', specVersion: '1.5',
        metadata: {component: {'bom-ref': 'root', type: 'application', name: 'web'}},
        components: [
            {'bom-ref': 'a', type: 'library', name: 'lodash', version: '4.17.15', purl: 'pkg:npm/lodash@4.17.15'},
            {'bom-ref': 'b', type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0'},
        ],
        dependencies: [{ref: 'root', dependsOn: ['a', 'b']}],
    }))
    process.env.TRIVY_BIN = stub('trivy', `if [ "$1" = --version ]; then echo '{"Version":"0.72.0"}'; exit 0; fi
if [ "$1" = image ]; then exit 0; fi
cat <<'EOF'
${JSON.stringify(trivyReport)}
EOF
`)
    process.env.GRYPE_BIN = stub('grype', `case "$1" in
  version) echo '{"version":"0.115.0"}'; exit 0 ;;
  db) echo '{}'; exit 0 ;;
esac
echo '{"matches":[]}'
`)
})

afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
})

beforeEach(() => {
    fs.rmSync(callLog, {force: true})
    clearSbomCache()
    clearLocalScanCache()
    resetVulnSources()
    deferSbomFindings(true)
    warnings.length = 0
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(((message: string) => {
        warnings.push(message)
        return log
    }) as any)
    infoSpy = vi.spyOn(log, 'info').mockImplementation((() => log) as any)
})

afterEach(() => {
    global.fetch = realFetch
    deferSbomFindings(false)
    warnSpy.mockRestore()
    infoSpy.mockRestore()
})

const scannerCalls = () => fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n') : []

function start() {
    const targets = collectSbomTargets([{plugins: [sbomNpm], files: [sbomFile]}], filesForPlugin)
    const outcome = startServerVulnerabilities(config, targets, {
        githubReady: Promise.resolve(), prescanFiles: () => [sbomFile], hasGithubToken: false,
    })
    return {targets, outcome}
}

/** The project the parser hands out for the file — deferred, so it must not scan anything. */
async function parsed() {
    const context: DependencyFileContext = {root: tmpDir, lockFile: 'web.cdx.json', type: 'cyclonedx:npm:0'}
    return sbomNpm.parser!.parseDependencyTree(context)
}

describe('vulnerabilities from the server', () => {
    it('asks once for every purl and attaches the answer to the parser\'s own projects, with no local scanner run', async () => {
        const calls: any[] = []
        global.fetch = (async (url: string, init: any) => {
            calls.push({url, purls: JSON.parse(init.body).purls})
            return new Response(JSON.stringify({
                vulnerabilities: {'pkg:npm/lodash@4.17.15': [serverFinding]},
                unsupported: [],
                databases: {
                    trivy: {built_at: '2026-10-01T19:00:16Z', schema: '2', age_seconds: 3600, stale: false},
                    grype: {built_at: '2026-09-01T06:33:48Z', schema: 'v6.1.9', age_seconds: 30 * 86400, stale: true},
                },
                scanners: {trivy: '0.74.0', grype: '0.118.0'},
            }), {status: 200, headers: {'server-timing': 'total;dur=12'}})
        }) as any

        const {targets, outcome} = start()
        const result = await outcome
        const project = await parsed()

        expect(calls).toEqual([{url: 'http://vuln.example:8080/vulnerabilities', purls: ['pkg:npm/lodash@4.17.15', 'pkg:npm/left-pad@1.3.0']}])
        expect(scannerCalls()).toEqual([])
        expect(targets.map(it => it.project)).toEqual([project])
        expect(project.exactVersionVulnerabilities).toBe(true)
        expect(project.dependencies['lodash@4.17.15'].vulnerabilities).toEqual([serverFinding])
        expect(project.dependencies['left-pad@1.3.0'].vulnerabilities).toEqual([])
        expect(result.source).toBe('server')
        expect(warnings.some(it => it.includes('grype database (built 2026-09-01T06:33:48Z) is 30 days old'))).toBe(true)

        if (result.source !== 'server') return
        const folder = fs.mkdtempSync(path.join(tmpDir, 'out-'))
        writeServerProvenance(folder, result)
        const provenance = JSON.parse(fs.readFileSync(path.join(folder, PROVENANCE_FILE), 'utf8'))
        expect(provenance).toMatchObject({
            vulnerabilitySource: 'server',
            vulnerabilityServer: 'vuln.example:8080',
            scanners: {trivy: '0.74.0', grype: '0.118.0'},
            databases: {grype: {built_at: '2026-09-01T06:33:48Z', stale: true}, trivy: {built_at: '2026-10-01T19:00:16Z', stale: false}},
            sbomFiles: [{file: sbomFile, purls: 2, vulnerablePurls: 1, findingEntries: 1}],
        })
        expect(vulnSummaryLine(result, false)).toEqual({
            level: 'warn',
            text: expect.stringContaining('vulnerability server vuln.example:8080, trivy 0.74.0'),
        })
    })

    it('falls back to the local scan, exactly as without a server, when the server fails', async () => {
        global.fetch = (async () => new Response('{"error":"scan failed","reason":"boom"}', {status: 500})) as any

        const {outcome} = start()
        const result = await outcome
        const project = await parsed()

        expect(result).toMatchObject({source: 'local', fallbackReason: 'HTTP 500 (scan failed: boom)'})
        expect(warnings).toContain('Vulnerability server unavailable (HTTP 500 (scan failed: boom)); '
            + 'scanning the SBOMs locally with Trivy and Grype instead')
        // Preflight, database refresh and one scan per tool — the local path, run only now.
        const calls = scannerCalls()
        expect(calls).toEqual(expect.arrayContaining([
            'trivy --version --format json', 'grype version -o json', 'trivy image --download-db-only',
            'grype db update', `trivy sbom --format json ${sbomFile}`, `grype sbom:${sbomFile} -o json`,
        ]))
        expect(project.exactVersionVulnerabilities).toBe(true)
        expect(project.dependencies['lodash@4.17.15'].vulnerabilities?.map(it => it.identifiers?.[0].value)).toEqual(['CVE-2021-23337'])
        expect(project.dependencies['lodash@4.17.15'].vulnerabilities?.[0].source).toBe('trivy')
        expect(project.dependencies['left-pad@1.3.0'].vulnerabilities).toEqual([])
        expect(vulnSummaryLine(result, false)?.text).toContain('the vulnerability server failed: HTTP 500')
    })

    it('falls back too when the server cannot be reached at all', async () => {
        global.fetch = (async () => { throw new TypeError('fetch failed') }) as any

        const result = await start().outcome

        expect(result).toMatchObject({source: 'local', fallbackReason: 'fetch failed'})
        expect(scannerCalls().length).toBeGreaterThan(0)
    })
})
