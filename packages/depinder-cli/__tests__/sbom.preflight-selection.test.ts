import {PINNED_SCANNER_VERSIONS} from '@depinder/core'
import {scannerPreflightMessages} from '../src/plugins/sbom/preflight-messages'
import {ScannerPreflight, ScannerStatus} from '../src/plugins/sbom/scanner-preflight'
import {parseVulnSources, resetVulnSources, setVulnSources} from '../src/vuln-sources/selection'

/**
 * scannerPreflightMessages speaks only about the --vuln-source selection, not what happens to be
 * installed: no missing-tool warning, drift or PARTIAL for an unselected scanner. Statuses are
 * built in memory. Final-summary wording lives in sbom.scanner-outcomes.test.ts.
 */

/** One scanner's probe result: installed, at the pinned version, unless told otherwise. */
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
    error: `binary '${tool}' not found - install ${tool}, or set ${tool.toUpperCase()}_BIN to its full path`,
})

const drifted = (version: string): Partial<ScannerStatus> => ({version, versionMatchesPin: false})

function preflight(trivy: ScannerStatus, grype: ScannerStatus): ScannerPreflight {
    return {trivy, grype, installedCount: (trivy.installed ? 1 : 0) + (grype.installed ? 1 : 0)}
}

const textOf = (p: ScannerPreflight, token: boolean, selection: string) =>
    scannerPreflightMessages(p, token, parseVulnSources(selection)).map(it => it.text).join('\n')

describe('scanner preflight messages follow --vuln-source, not what happens to be installed', () => {
    afterEach(resetVulnSources)

    it.each([
        ['trivy', 'grype'],
        ['grype', 'trivy'],
    ] as const)('a healthy selected %s says nothing about the missing unselected %s', (selectedTool, otherTool) => {
        const p = preflight(
            scanner('trivy', selectedTool === 'grype' ? missing('trivy') : {}),
            scanner('grype', selectedTool === 'trivy' ? missing('grype') : {}),
        )
        const messages = scannerPreflightMessages(p, false, parseVulnSources(selectedTool))
        expect(messages).toEqual([{
            level: 'info',
            text: `Vulnerability scanners: ${selectedTool} ${PINNED_SCANNER_VERSIONS[selectedTool]} (DB 2, built 2026-08-18T00:00:00Z)`,
        }])
        expect(messages.map(it => it.text).join('\n')).not.toContain(otherTool)
    })

    it.each(['trivy', 'grype'] as const)('ignores version drift of the unselected scanner under --vuln-source %s', (selectedTool) => {
        const driftedTool = selectedTool === 'trivy' ? 'grype' : 'trivy'
        const p = preflight(
            scanner('trivy', driftedTool === 'trivy' ? drifted('0.99.9') : {}),
            scanner('grype', driftedTool === 'grype' ? drifted('0.99.9') : {}),
        )
        const messages = scannerPreflightMessages(p, false, parseVulnSources(selectedTool))
        expect(messages.filter(it => it.level === 'warn')).toEqual([])
        expect(messages.map(it => it.text).join('\n')).not.toContain(driftedTool)
    })

    it.each(['trivy', 'grype'] as const)('still warns when the selected %s drifts', (selectedTool) => {
        const p = preflight(
            scanner('trivy', selectedTool === 'trivy' ? drifted('0.99.9') : {}),
            scanner('grype', selectedTool === 'grype' ? drifted('0.99.9') : {}),
        )
        const warnings = scannerPreflightMessages(p, false, parseVulnSources(selectedTool))
            .filter(it => it.level === 'warn')
        expect(warnings).toHaveLength(1)
        expect(warnings[0].text)
            .toContain(`${selectedTool} 0.99.9 differs from the reference version ${PINNED_SCANNER_VERSIONS[selectedTool]}`)
    })

    it.each(['trivy', 'grype'] as const)('names only the selected tool when it is missing and the unselected %s runs fine', (missingTool) => {
        const healthyTool = missingTool === 'trivy' ? 'grype' : 'trivy'
        const p = preflight(
            scanner('trivy', missingTool === 'trivy' ? missing('trivy') : {}),
            scanner('grype', missingTool === 'grype' ? missing('grype') : {}),
        )
        const text = scannerPreflightMessages(p, false, parseVulnSources(missingTool)).map(it => it.text).join('\n')
        expect(text).toContain(`NO selected local vulnerability scanner available: ${missingTool} could not be run`)
        expect(text).toContain(`${missingTool.toUpperCase()}_BIN`)
        expect(text).not.toContain(healthyTool)
        expect(text).not.toContain('PARTIAL')
        expect(text).not.toContain('neither')
    })

    it('keeps the PARTIAL warning when both scanners are selected and one is missing', () => {
        const p = preflight(scanner('trivy'), scanner('grype', missing('grype')))
        const text = textOf(p, false, 'trivy,grype')
        expect(text).toContain('PARTIAL vulnerability analysis: grype is not available')
        expect(text).toContain('install grype, or set GRYPE_BIN')
    })

    it('keeps the two-argument preflight default at both scanners even when the process selection differs', () => {
        setVulnSources(parseVulnSources('trivy'))
        const p = preflight(scanner('trivy'), scanner('grype', missing('grype')))
        expect(scannerPreflightMessages(p, false).map(it => it.text).join('\n'))
            .toContain('PARTIAL vulnerability analysis: grype is not available')
    })

    it('says nothing about local scanners when only GitHub Advisories is selected', () => {
        const p = preflight(scanner('trivy', missing('trivy')), scanner('grype', missing('grype')))
        const selection = parseVulnSources('github')
        expect(scannerPreflightMessages(p, false, selection)).toEqual([])
        expect(scannerPreflightMessages(p, true, selection)).toEqual([])
    })

    it('names the missing selected scanner while crediting the GitHub cache, not disabled', () => {
        const p = preflight(scanner('trivy', missing('trivy')), scanner('grype'))
        const text = textOf(p, false, 'trivy,github')
        expect(text).toContain('NO selected local vulnerability scanner available: trivy could not be run')
        expect(text).toContain('GitHub Advisories is selected; vulnerabilities can still come from its local advisory cache.')
        expect(text).not.toContain('DISABLED')
        expect(text).not.toContain('grype')
    })

    it('still falls back on GH_TOKEN when it is set and no selected scanner ran', () => {
        const p = preflight(scanner('trivy', missing('trivy')), scanner('grype'))
        const text = scannerPreflightMessages(p, true, parseVulnSources('trivy')).map(it => it.text).join('\n')
        expect(text).toContain('NO selected local vulnerability scanner available: trivy could not be run')
        expect(text).toContain('FALLBACK: GH_TOKEN is set')
    })
})
