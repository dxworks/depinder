import path from 'path'
import {PINNED_SCANNER_VERSIONS} from '@depinder/core'
import {scannerSummaryLine} from '../src/plugins/sbom/preflight-messages'
import {ScannerPreflight, ScannerStatus} from '../src/plugins/sbom/scanner-preflight'
import {
    clearScannedFiles,
    recordedScans,
    recordScannedFile,
    ScannedFileRecord,
} from '../src/plugins/sbom/scan-provenance'
import {vulnSummaryLine} from '../src/vuln-sources/run'
import {VulnServerAnswer} from '../src/vuln-sources/server'
import {parseVulnSources, resetVulnSources, setVulnSources} from '../src/vuln-sources/selection'

/**
 * The wording of the summary lines for each verdict localScanOutcome produces (classified in
 * sbom.scan-outcomes.test.ts). recordedScans is the getter the CLI feeds the lines with.
 */

function scanner(tool: 'trivy' | 'grype', overrides: Partial<ScannerStatus> = {}): ScannerStatus {
    return {
        tool,
        bin: tool,
        installed: true,
        version: PINNED_SCANNER_VERSIONS[tool],
        pinnedVersion: PINNED_SCANNER_VERSIONS[tool],
        versionMatchesPin: true,
        dbVersion: '2',
        dbBuiltAt: '2026-08-18T00:00:00Z',
        ...overrides,
    }
}

const missing = (tool: 'trivy' | 'grype'): Partial<ScannerStatus> => ({
    installed: false,
    version: undefined,
    dbVersion: undefined,
    dbBuiltAt: undefined,
    error: `binary '${tool}' not found`,
})

function preflight(trivy: ScannerStatus, grype: ScannerStatus): ScannerPreflight {
    return {trivy, grype, installedCount: (trivy.installed ? 1 : 0) + (grype.installed ? 1 : 0)}
}

const record = (file: string, statuses: {trivy?: 'ok' | 'skipped', grype?: 'ok' | 'skipped'}): ScannedFileRecord => ({
    file,
    trivy: statuses.trivy ?? 'skipped',
    grype: statuses.grype ?? 'skipped',
    findingEntries: 0,
    packageKeys: 0,
})

const bothInstalled = preflight(scanner('trivy'), scanner('grype'))

describe('scannerSummaryLine formats the classified outcome', () => {
    it('complete run of both scanners joins their versions', () => {
        const message = scannerSummaryLine(bothInstalled, false, parseVulnSources('trivy,grype'),
            [record('a.cdx.json', {trivy: 'ok', grype: 'ok'})])

        expect(message).toEqual({
            level: 'info',
            text: `Vulnerability data source: trivy ${PINNED_SCANNER_VERSIONS.trivy} + grype ${PINNED_SCANNER_VERSIONS.grype}`,
        })
    })

    it('partial names the produced source and the scanner that missed a file', () => {
        const message = scannerSummaryLine(bothInstalled, false, parseVulnSources('trivy,grype'),
            [record('a.cdx.json', {trivy: 'ok'})])

        expect(message).toEqual({
            level: 'warn',
            text: `Vulnerability data source: trivy ${PINNED_SCANNER_VERSIONS.trivy} - PARTIAL, grype did not complete every SBOM`,
        })
    })

    it('an installed scanner that produced no report is not a data source', () => {
        const message = scannerSummaryLine(bothInstalled, false, parseVulnSources('trivy'), [record('a.cdx.json', {})])

        expect(message).toEqual({
            level: 'warn',
            text: 'Vulnerability data source: NONE - no selected local scanner produced a report',
        })
    })

    it('a token without reports is the advisory fallback, not a scanner claim', () => {
        const message = scannerSummaryLine(bothInstalled, true, parseVulnSources('trivy'), [record('a.cdx.json', {})])

        expect(message).toEqual({
            level: 'warn',
            text: 'Vulnerability data source: GitHub Advisories (fallback) - no selected local scanner produced a report',
        })
    })

    it('selected GitHub with failed local scans names the advisory mode, not a fallback', () => {
        const message = scannerSummaryLine(bothInstalled, true, parseVulnSources('trivy,github'), [record('a.cdx.json', {})])

        expect(message).toEqual({
            level: 'warn',
            text: 'Vulnerability data source: GitHub Advisories - selected local scanners produced no reports',
        })
    })

    it('a GitHub-only selection ignores local records entirely', () => {
        const records = [record('a.cdx.json', {}), record('a.cdx.json', {trivy: 'ok'})]
        const message = scannerSummaryLine(bothInstalled, true, parseVulnSources('github'), records)

        expect(message).toEqual({level: 'info', text: 'Vulnerability data source: GitHub Advisories'})
    })

    it('shows an unprobed version as ? rather than claiming the binary was missing', () => {
        const p = preflight(scanner('trivy', {version: undefined, versionMatchesPin: false}), scanner('grype', missing('grype')))
        const message = scannerSummaryLine(p, false, parseVulnSources('trivy'), [record('a.cdx.json', {trivy: 'ok'})])

        expect(message).toEqual({level: 'info', text: 'Vulnerability data source: trivy ?'})
    })
})

describe('vulnSummaryLine with recorded scan outcomes', () => {
    afterEach(resetVulnSources)

    it('keeps the server-failure suffix on a records-based local line', () => {
        setVulnSources(parseVulnSources('trivy'))
        const outcome = {source: 'local' as const, preflight: bothInstalled, fallbackReason: 'HTTP 500'}
        const message = vulnSummaryLine(outcome, false, [record('a.cdx.json', {trivy: 'ok'})])

        expect(message).toEqual({
            level: 'warn',
            text: `Vulnerability data source: trivy ${PINNED_SCANNER_VERSIONS.trivy}`
                + ' (local scan: the vulnerability server failed: HTTP 500)',
        })
    })

    it('a server outcome ignores records and keeps its own line', () => {
        const answer: VulnServerAnswer = {
            vulnerabilities: new Map(),
            unsupported: new Map(),
            databases: {trivy: [], grype: []},
            scanners: {trivy: [], grype: []},
            purls: 0,
            requests: 0,
            serverTiming: {},
        }
        const message = vulnSummaryLine(
            {source: 'server', server: 'http://test', answer, files: []}, false, [record('a.cdx.json', {})])

        expect(message?.text).toContain('vulnerability server http://test')
    })

    it('a local outcome without a preflight stays silent', () => {
        expect(vulnSummaryLine({source: 'local'}, false, [])).toBeUndefined()
    })
})

describe('recordedScans', () => {
    const fileA = path.resolve('a.cdx.json')
    const fileB = path.resolve('b.cdx.json')

    beforeEach(clearScannedFiles)
    afterEach(clearScannedFiles)

    it('returns every record when no filter is given, and copies that cannot mutate the store', () => {
        recordScannedFile(fileA).trivy = 'ok'
        recordScannedFile(fileB)

        const all = recordedScans()
        expect(all.map(it => it.file)).toEqual([fileA, fileB])
        all[0].trivy = 'skipped'
        expect(recordedScans()[0].trivy).toBe('ok')
    })

    it('filters to the requested files by resolved path, so a stale success cannot mask a current failure', () => {
        recordScannedFile(path.resolve('previous-run.cdx.json')).trivy = 'ok' // stale record, not asked for
        recordScannedFile(fileA) // this run asked for it; the scan produced nothing
        recordScannedFile(fileB).grype = 'ok'

        // The filter resolves paths, so a relative CLI argument still finds the absolute record.
        const current = recordedScans([path.relative(process.cwd(), fileA)])
        expect(current).toHaveLength(1)
        expect(current[0].file).toBe(fileA)
        expect(current[0].trivy).toBe('skipped')

        expect(recordedScans([fileA, fileB])).toHaveLength(2)
        expect(recordedScans([])).toEqual([])
    })
})
