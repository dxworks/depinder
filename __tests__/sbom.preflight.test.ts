import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    PINNED_SCANNER_VERSIONS,
    PROVENANCE_FILE,
    ScannerPreflight,
    clearLocalScanCache,
    preflightScanners,
    scanSbomFileOnce,
    scannerFailureReason,
    scannerPreflightMessages,
    scannerSummaryLine,
    writeScanProvenance,
} from '../src/plugins/sbom/local-scan'
import {log} from '../src/utils/logging'
import {sbomFilesFor, sbomJava} from '../src/plugins/sbom'
import {java} from '../src/plugins/java'

/**
 * The preflight is the only thing standing between a user with no scanners and a completed run
 * with silently empty vulnerability columns, so what it SAYS is the behaviour under test, not just
 * whether it detected something. Scanners are stubbed with shell scripts — no real binaries.
 *
 * Version/DB payloads mirror real `trivy --version --format json`, `grype version -o json` and
 * `grype db status -o json` output measured against the pinned pair.
 */

let tmpDir: string
let sbomFile: string
const originalEnv = {TRIVY_BIN: process.env.TRIVY_BIN, GRYPE_BIN: process.env.GRYPE_BIN}

const trivyVersionJson = (version: string) => JSON.stringify({
    Version: version,
    VulnerabilityDB: {Version: 2, UpdatedAt: '2026-08-18T12:56:24Z'},
})

const grypeVersionJson = (version: string) => JSON.stringify({application: 'grype', version})
const grypeDbStatusJson = JSON.stringify({schemaVersion: 'v6.1.9', built: '2026-08-18T06:15:38Z', valid: true})

const trivyReport = {
    Results: [{
        Vulnerabilities: [{
            VulnerabilityID: 'CVE-2021-44228',
            PkgName: 'org.apache.logging.log4j:log4j-core',
            InstalledVersion: '2.11.1',
            PkgIdentifier: {PURL: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1'},
            Severity: 'CRITICAL',
        }],
    }],
}

/** A stub trivy: answers `--version` with a version document, anything else with a scan report. */
function stubTrivy(name: string, version: string): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, `#!/bin/sh
if [ "$1" = --version ]; then
  cat <<'EOF'
${trivyVersionJson(version)}
EOF
  exit 0
fi
cat <<'EOF'
${JSON.stringify(trivyReport)}
EOF
`)
    fs.chmodSync(file, 0o755)
    return file
}

/** A stub grype: answers `version` and `db status`, anything else with an empty match set. */
function stubGrype(name: string, version: string): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, `#!/bin/sh
case "$1" in
  version) cat <<'EOF'
${grypeVersionJson(version)}
EOF
  exit 0 ;;
  db) cat <<'EOF'
${grypeDbStatusJson}
EOF
  exit 0 ;;
esac
echo '{"matches":[]}'
`)
    fs.chmodSync(file, 0o755)
    return file
}

const missing = (name: string) => path.join(tmpDir, `nonexistent-${name}`)
const textOf = (preflight: ScannerPreflight, ghToken: boolean) =>
    scannerPreflightMessages(preflight, ghToken).map(it => it.text).join('\n')

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-preflight-'))
    sbomFile = path.join(tmpDir, 'p.cdx.json')
    fs.writeFileSync(sbomFile, JSON.stringify({metadata: {}, components: [], dependencies: []}))
})

afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

beforeEach(() => clearLocalScanCache())

afterEach(() => {
    process.env.TRIVY_BIN = originalEnv.TRIVY_BIN
    process.env.GRYPE_BIN = originalEnv.GRYPE_BIN
    if (originalEnv.TRIVY_BIN === undefined) delete process.env.TRIVY_BIN
    if (originalEnv.GRYPE_BIN === undefined) delete process.env.GRYPE_BIN
})

describe('scanner preflight detection', () => {
    it('reads versions and DB build dates from both scanners', async () => {
        process.env.TRIVY_BIN = stubTrivy('trivy-pinned.sh', PINNED_SCANNER_VERSIONS.trivy)
        process.env.GRYPE_BIN = stubGrype('grype-pinned.sh', PINNED_SCANNER_VERSIONS.grype)

        const preflight = await preflightScanners()

        expect(preflight.installedCount).toBe(2)
        expect(preflight.trivy).toMatchObject({
            installed: true, version: PINNED_SCANNER_VERSIONS.trivy, versionMatchesPin: true,
            dbVersion: '2', dbBuiltAt: '2026-08-18T12:56:24Z',
        })
        expect(preflight.grype).toMatchObject({
            installed: true, version: PINNED_SCANNER_VERSIONS.grype, versionMatchesPin: true,
            dbVersion: 'v6.1.9', dbBuiltAt: '2026-08-18T06:15:38Z',
        })
    })

    it('reports a missing binary with the env var that fixes it, and probes only once', async () => {
        process.env.TRIVY_BIN = missing('trivy')
        process.env.GRYPE_BIN = missing('grype')

        const preflight = await preflightScanners()

        expect(preflight.installedCount).toBe(0)
        expect(preflight.trivy.error).toContain('TRIVY_BIN')
        expect(preflight.grype.error).toContain('GRYPE_BIN')
        // Cached: the second call must be the same object, not a second round of execFile.
        expect(await preflightScanners()).toBe(preflight)
    })
})

describe('preflight messages', () => {
    it('states both scanners and their DBs when everything is present and pinned', async () => {
        process.env.TRIVY_BIN = stubTrivy('trivy-ok.sh', PINNED_SCANNER_VERSIONS.trivy)
        process.env.GRYPE_BIN = stubGrype('grype-ok.sh', PINNED_SCANNER_VERSIONS.grype)

        const preflight = await preflightScanners()
        const messages = scannerPreflightMessages(preflight, false)

        expect(messages).toHaveLength(1)
        expect(messages[0].level).toBe('info')
        expect(messages[0].text).toBe(
            `Vulnerability scanners: trivy ${PINNED_SCANNER_VERSIONS.trivy} (DB 2, built 2026-08-18T12:56:24Z), `
            + `grype ${PINNED_SCANNER_VERSIONS.grype} (DB v6.1.9, built 2026-08-18T06:15:38Z)`)
        expect(scannerSummaryLine(preflight, false).level).toBe('info')
    })

    it('warns that results are partial and names the missing tool', async () => {
        process.env.TRIVY_BIN = stubTrivy('trivy-partial.sh', PINNED_SCANNER_VERSIONS.trivy)
        process.env.GRYPE_BIN = missing('grype')

        const preflight = await preflightScanners()
        const text = textOf(preflight, false)

        expect(text).toContain('PARTIAL vulnerability analysis: grype is not available')
        expect(text).toContain('install grype, or set GRYPE_BIN')
        expect(text).toContain('substantially different sets of vulnerabilities')
        expect(scannerSummaryLine(preflight, false)).toEqual({
            level: 'warn',
            text: 'Vulnerability data source: trivy only — PARTIAL, grype was not available',
        })
    })

    it('says vulnerability analysis is disabled when neither scanner nor GH_TOKEN is available', async () => {
        process.env.TRIVY_BIN = missing('trivy')
        process.env.GRYPE_BIN = missing('grype')

        const preflight = await preflightScanners()
        const text = textOf(preflight, false)

        expect(text).toContain('NO local vulnerability scanner available')
        expect(text).toContain('VULNERABILITY ANALYSIS IS DISABLED')
        expect(text).toContain('Set GH_TOKEN to fall back')
        expect(text).not.toContain('FALLBACK: GH_TOKEN is set')
        expect(scannerSummaryLine(preflight, false).text)
            .toBe('Vulnerability data source: NONE — the vulnerability columns are empty because no scanner ran')
    })

    it('says it fell back to advisories when scanners are missing but GH_TOKEN is set', async () => {
        process.env.TRIVY_BIN = missing('trivy')
        process.env.GRYPE_BIN = missing('grype')

        const preflight = await preflightScanners()
        const text = textOf(preflight, true)

        expect(text).toContain('FALLBACK: GH_TOKEN is set')
        expect(text).not.toContain('VULNERABILITY ANALYSIS IS DISABLED')
        expect(scannerSummaryLine(preflight, true).text)
            .toBe('Vulnerability data source: GitHub Advisories (fallback) — no local scanner ran')
    })

    it('warns on a version that differs from the pinned pair, without disabling anything', async () => {
        process.env.TRIVY_BIN = stubTrivy('trivy-drifted.sh', '0.99.9')
        process.env.GRYPE_BIN = stubGrype('grype-pinned2.sh', PINNED_SCANNER_VERSIONS.grype)

        const preflight = await preflightScanners()
        const warnings = scannerPreflightMessages(preflight, false).filter(it => it.level === 'warn')

        expect(preflight.trivy.versionMatchesPin).toBe(false)
        expect(preflight.grype.versionMatchesPin).toBe(true)
        expect(warnings).toHaveLength(1)
        expect(warnings[0].text).toContain(`trivy 0.99.9 differs from the reference version ${PINNED_SCANNER_VERSIONS.trivy}`)
        expect(warnings[0].text).toContain(PROVENANCE_FILE)
    })
})

describe('scan provenance', () => {
    it('records tool and DB versions, the files scanned and whether each scanner ran', async () => {
        process.env.TRIVY_BIN = stubTrivy('trivy-prov.sh', PINNED_SCANNER_VERSIONS.trivy)
        process.env.GRYPE_BIN = missing('grype')

        const result = await scanSbomFileOnce(sbomFile)
        expect(result.available).toBe(true)

        const resultFolder = fs.mkdtempSync(path.join(tmpDir, 'results-'))
        const file = await writeScanProvenance(resultFolder, false)

        expect(path.basename(file)).toBe(PROVENANCE_FILE)
        const provenance = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(provenance.vulnerabilityAnalysis).toBe('partial')
        expect(provenance.pinnedVersions).toEqual(PINNED_SCANNER_VERSIONS)
        expect(provenance.scanners.trivy).toMatchObject({
            installed: true, version: PINNED_SCANNER_VERSIONS.trivy, dbVersion: '2', dbBuiltAt: '2026-08-18T12:56:24Z',
        })
        expect(provenance.scanners.grype.installed).toBe(false)
        // One finding, indexed under both the purl and the name@version key.
        expect(provenance.sbomFiles).toEqual([
            {file: sbomFile, trivy: 'ok', grype: 'skipped', findingEntries: 2, packageKeys: 2},
        ])
    })

    it('lists only the given SBOMs, each with the tool that wrote it, for a per-source file', async () => {
        process.env.TRIVY_BIN = stubTrivy('trivy-prov-src.sh', PINNED_SCANNER_VERSIONS.trivy)
        process.env.GRYPE_BIN = missing('grype')
        const other = path.join(tmpDir, 'other.cdx.json')
        fs.writeFileSync(other, JSON.stringify({metadata: {}, components: [], dependencies: []}))
        await scanSbomFileOnce(sbomFile)
        await scanSbomFileOnce(other)

        const resultFolder = fs.mkdtempSync(path.join(tmpDir, 'results-'))
        const file = await writeScanProvenance(resultFolder, false, [{
            file: other, producer: 'syft', toolVersion: '1.46.0', repo: 'other', repoFromMetadata: true, purlTypes: new Set(),
        }])

        const provenance = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(provenance.source).toBe('syft')
        expect(provenance.sbomFiles).toEqual([
            {file: other, trivy: 'ok', grype: 'skipped', findingEntries: 2, packageKeys: 2, producer: 'syft', producerVersion: '1.46.0', repo: 'other'},
        ])
    })

    it('marks the run disabled when nothing ran and no token is set', async () => {
        process.env.TRIVY_BIN = missing('trivy')
        process.env.GRYPE_BIN = missing('grype')

        const resultFolder = fs.mkdtempSync(path.join(tmpDir, 'results-'))
        const provenance = JSON.parse(fs.readFileSync(await writeScanProvenance(resultFolder, false), 'utf8'))

        expect(provenance.vulnerabilityAnalysis).toBe('disabled')
        expect(provenance.githubAdvisoryFallback).toBe(false)
    })
})

describe('sbomFilesFor', () => {
    it('lists the SBOM files an sbom plugin selection would scan', () => {
        const files = ['/x/zeppelin.cdx.json', '/x/zeppelin.trivy.cdx.json', '/x/pom.xml']
        expect(sbomFilesFor([sbomJava], files)).toEqual(['/x/zeppelin.cdx.json', '/x/zeppelin.trivy.cdx.json'])
    })

    it('is empty when no sbom plugin is selected, so a native run never preflights scanners', () => {
        expect(sbomFilesFor([java], ['/x/zeppelin.cdx.json'])).toEqual([])
    })
})


/**
 * The database refresh and the failure message, which are what a stale DB actually costs.
 *
 * Measured 2026-09-15: twelve SBOMs scanned at once against a day-old Trivy DB produced twelve
 * `Command failed: trivy sbom --format json <file>` warnings and empty vulnerability columns.
 * Every process had tried to download the same archive, and the one line the user saw named the
 * command but not the reason. Both halves are covered here.
 */
describe('scanner database refresh', () => {
    /** A trivy stub that records every invocation and fails the scan the way a broken DB does. */
    function stubTrivyRecording(name: string, callLog: string, scanFails: boolean): string {
        const file = path.join(tmpDir, name)
        fs.writeFileSync(file, `#!/bin/sh
echo "$@" >> ${callLog}
if [ "$1" = "--version" ]; then
  cat <<'EOF'
${trivyVersionJson(PINNED_SCANNER_VERSIONS.trivy)}
EOF
  exit 0
fi
if [ "$1" = "image" ]; then exit 0; fi
${scanFails
        ? `echo "FATAL\tinit error: DB error: failed to download vulnerability DB" 1>&2
exit 1`
        : `cat <<'EOF'
${JSON.stringify(trivyReport)}
EOF
exit 0`}
`)
        fs.chmodSync(file, 0o755)
        return file
    }

    it('downloads the database once for the whole run, however many files are scanned at once', async () => {
        const callLog = path.join(tmpDir, 'calls-once.txt')
        fs.writeFileSync(callLog, '')
        process.env.TRIVY_BIN = stubTrivyRecording('trivy-recording.sh', callLog, false)
        process.env.GRYPE_BIN = missing('grype')

        const second = path.join(tmpDir, 'q.cdx.json')
        fs.writeFileSync(second, JSON.stringify({metadata: {}, components: [], dependencies: []}))
        await Promise.all([scanSbomFileOnce(sbomFile), scanSbomFileOnce(second)])

        const calls = fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean)
        expect(calls.filter(it => it.startsWith('image --download-db-only'))).toHaveLength(1)
        // Both files were still scanned — the refresh gates the scans, it does not replace them.
        expect(calls.filter(it => it.startsWith('sbom --format json'))).toHaveLength(2)
    })

    it('keeps the scanner\'s own reason in the warning when a scan fails', async () => {
        const callLog = path.join(tmpDir, 'calls-failing.txt')
        fs.writeFileSync(callLog, '')
        process.env.TRIVY_BIN = stubTrivyRecording('trivy-failing.sh', callLog, true)
        process.env.GRYPE_BIN = missing('grype')
        const warn = jest.spyOn(log, 'warn').mockImplementation(() => log)

        try {
            const result = await scanSbomFileOnce(sbomFile)
            expect(result.available).toBe(false)
            const skipped = warn.mock.calls.map(it => String(it[0])).find(it => it.includes('scan of p.cdx.json skipped'))
            expect(skipped).toContain('Command failed')
            expect(skipped).toContain('failed to download vulnerability DB')
        } finally {
            warn.mockRestore()
        }
    })

    it('reads the last failing stderr line, not the scanner\'s progress chatter', () => {
        const reason = scannerFailureReason({
            message: 'Command failed: trivy sbom --format json /x/p.cdx.json\nFATAL\tinit error',
            stderr: 'INFO\tNeed to update DB\nINFO\tDownloading vulnerability DB...\nFATAL\tinit error: DB error: failed to download\n',
        })

        expect(reason).toBe('Command failed: trivy sbom --format json /x/p.cdx.json \u2014 FATAL\tinit error: DB error: failed to download')
    })
})
