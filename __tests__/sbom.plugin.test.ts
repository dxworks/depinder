import fs from 'fs'
import os from 'os'
import path from 'path'
import {clearSbomCache, sbomJava, sbomNpm} from '../src/plugins/sbom'
import {clearLocalScanCache} from '../src/plugins/sbom/local-scan'
import {DependencyFileContext, DepinderProject} from '../src/extension-points/extract'

/**
 * Covers the sbom plugin wiring: whether a local scan ran is a property of the parsed project
 * (`exactVersionVulnerabilities`), not something analyse.ts has to infer from an undefined field.
 * Scanners are stubbed with shell scripts so the tests stay hermetic and never need real binaries.
 */

let tmpDir: string
let sbomFile: string
const originalEnv = {TRIVY_BIN: process.env.TRIVY_BIN, GRYPE_BIN: process.env.GRYPE_BIN}

const bom = {
    metadata: {component: {'bom-ref': 'root', type: 'file', name: '/repo'}},
    components: [
        {
            'bom-ref': 'a', type: 'library', group: 'org.apache.logging.log4j', name: 'log4j-core',
            version: '2.11.1', purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1',
        },
        {
            'bom-ref': 'b', type: 'library', group: 'org.slf4j', name: 'slf4j-api',
            version: '1.7.35', purl: 'pkg:maven/org.slf4j/slf4j-api@1.7.35',
        },
        {
            'bom-ref': 'c', type: 'library', name: 'side-channel', version: '1.1.0',
            purl: 'pkg:npm/side-channel@1.1.0',
        },
    ],
    dependencies: [],
}

const trivyReport = {
    Results: [{
        Vulnerabilities: [{
            VulnerabilityID: 'CVE-2021-44228',
            PkgName: 'org.apache.logging.log4j:log4j-core',
            InstalledVersion: '2.11.1',
            PkgIdentifier: {PURL: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1'},
            Severity: 'CRITICAL',
            PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2021-44228',
        }],
    }],
}

/**
 * A stub binary that prints `report` and, if given, appends a line to `counterFile` per SCAN.
 * The preflight probe invokes the same binary with `--version`, which must not count as a scan.
 */
function stubScanner(name: string, report: unknown, counterFile?: string): string {
    const file = path.join(tmpDir, name)
    const count = counterFile ? `[ "$1" = --version ] || [ "$1" = version ] || echo x >> ${counterFile}\n` : ''
    fs.writeFileSync(file, `#!/bin/sh\n${count}cat <<'EOF'\n${JSON.stringify(report)}\nEOF\n`)
    fs.chmodSync(file, 0o755)
    return file
}

function contextsFor(plugin: typeof sbomJava): DependencyFileContext[] {
    return plugin.extractor.createContexts([sbomFile])
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const parse = (plugin: typeof sbomJava, context: DependencyFileContext): Promise<DepinderProject> =>
    Promise.resolve(plugin.parser!.parseDependencyTree(context))

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-sbom-plugin-'))
    sbomFile = path.join(tmpDir, 'p.cdx.json')
    fs.writeFileSync(sbomFile, JSON.stringify(bom))
})

afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

beforeEach(() => {
    // Both caches are process-global; without this a stubbed scan poisons the next test.
    clearSbomCache()
    clearLocalScanCache()
})

afterEach(() => {
    process.env.TRIVY_BIN = originalEnv.TRIVY_BIN
    process.env.GRYPE_BIN = originalEnv.GRYPE_BIN
    if (originalEnv.TRIVY_BIN === undefined) delete process.env.TRIVY_BIN
    if (originalEnv.GRYPE_BIN === undefined) delete process.env.GRYPE_BIN
})

describe('sbom parser and the local scan', () => {
    it('leaves vulnerabilities alone and does not set the flag when no scanner exists', async () => {
        process.env.TRIVY_BIN = path.join(tmpDir, 'nonexistent-trivy')
        process.env.GRYPE_BIN = path.join(tmpDir, 'nonexistent-grype')

        const project = await parse(sbomJava, contextsFor(sbomJava)[0])

        expect(project.exactVersionVulnerabilities).toBeFalsy()
        expect(Object.values(project.dependencies).length).toBeGreaterThan(0)
        // Undefined, not [] — analyse.ts must fall through to the GHSA advisory path.
        Object.values(project.dependencies).forEach(dep => expect(dep.vulnerabilities).toBeUndefined())
    })

    it('sets the flag and attaches findings when a scanner ran', async () => {
        process.env.TRIVY_BIN = stubScanner('trivy-stub.sh', trivyReport)
        process.env.GRYPE_BIN = path.join(tmpDir, 'nonexistent-grype')

        const project = await parse(sbomJava, contextsFor(sbomJava)[0])

        expect(project.exactVersionVulnerabilities).toBe(true)
        const deps = project.dependencies
        expect(deps['org.apache.logging.log4j:log4j-core@2.11.1'].vulnerabilities).toHaveLength(1)
        // A dependency the scan did not match carries [] — absence is a result, not a gap.
        expect(deps['org.slf4j:slf4j-api@1.7.35'].vulnerabilities).toEqual([])
    })

    it('scans each SBOM file only once, across projects and plugins', async () => {
        const counter = path.join(tmpDir, 'calls.txt')
        fs.writeFileSync(counter, '')
        process.env.TRIVY_BIN = stubScanner('trivy-counted.sh', trivyReport, counter)
        process.env.GRYPE_BIN = path.join(tmpDir, 'nonexistent-grype')

        await parse(sbomJava, contextsFor(sbomJava)[0])
        await parse(sbomNpm, contextsFor(sbomNpm)[0])

        expect(fs.readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1)
    })
})
