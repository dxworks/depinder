import {DEFAULT_VULN_SOURCE, parseVulnSources, VulnSourceSelection} from '../../vuln-sources/selection'
import {localScanOutcome, LocalScanner} from './scan-outcomes'
import {PROVENANCE_FILE, ScannedFileRecord} from './scan-provenance'
import {ScannerPreflight, ScannerStatus} from './scanner-preflight'

/** What the user is told about the local scanners: the verdict up front and the reminder at the end. */

export interface PreflightMessage {
    level: 'info' | 'warn'
    text: string
}

function describe(status: ScannerStatus): string {
    const db = status.dbVersion || status.dbBuiltAt
        ? `DB ${status.dbVersion ?? 'unknown'}${status.dbBuiltAt ? `, built ${status.dbBuiltAt}` : ''}`
        : 'DB unknown'
    return `${status.tool} ${status.version ?? 'version unknown'} (${db})`
}

const BANNER = '='.repeat(78)

/** What callers that never passed a selection asked for: both local scanners, no GitHub. */
const DEFAULT_SELECTION = parseVulnSources(DEFAULT_VULN_SOURCE)

function selectedScanners(preflight: ScannerPreflight, selection: VulnSourceSelection): ScannerStatus[] {
    return [preflight.trivy, preflight.grype].filter(status => selection[status.tool])
}

/**
 * The user-facing verdict, as a list of lines for the caller to log.
 *
 * Kept pure and separate from logging so the exact wording is testable — this is the only place a
 * user learns that vulnerability data is missing, and a run that ends with silently empty columns
 * is the failure mode this exists to prevent.
 */
export function scannerPreflightMessages(
    preflight: ScannerPreflight,
    hasGithubToken: boolean,
    selection: VulnSourceSelection = DEFAULT_SELECTION,
): PreflightMessage[] {
    const messages: PreflightMessage[] = []
    const selected = selectedScanners(preflight, selection)
    const installed = selected.filter(it => it.installed)
    const missing = selected.filter(it => !it.installed)

    // No selected local scanner at all (a GitHub-only run): nothing local to report.
    if (selected.length === 0) return messages

    if (installed.length > 0) {
        messages.push({level: 'info', text: `Vulnerability scanners: ${installed.map(describe).join(', ')}`})
    }

    for (const status of installed) {
        if (status.versionMatchesPin) continue
        messages.push({
            level: 'warn',
            text: `${status.tool} ${status.version ?? '(version unreadable)'} differs from the reference `
                + `version ${status.pinnedVersion} these results were calibrated against — vulnerability counts `
                + `depend on the scanner version and its DB build date, both recorded in ${PROVENANCE_FILE}.`,
        })
    }

    if (installed.length > 0 && missing.length > 0) {
        const gone = missing[0]
        messages.push({level: 'warn', text: BANNER})
        messages.push({level: 'warn', text: `PARTIAL vulnerability analysis: ${gone.tool} is not available`})
        messages.push({level: 'warn', text: `  ${gone.tool}: ${gone.error ?? 'unavailable'}`})
        messages.push({
            level: 'warn',
            text: '  Trivy and Grype find substantially different sets of vulnerabilities; the results '
                + 'below\n  come from one tool only and are incomplete.',
        })
        messages.push({level: 'warn', text: BANNER})
    }

    if (installed.length === 0) {
        messages.push({level: 'warn', text: BANNER})
        if (missing.length === 1) {
            messages.push({level: 'warn', text: `NO selected local vulnerability scanner available: ${missing[0].tool} could not be run`})
        } else {
            messages.push({level: 'warn', text: 'NO local vulnerability scanner available — neither Trivy nor Grype could be run'})
        }
        for (const gone of missing) messages.push({level: 'warn', text: `  ${gone.tool}: ${gone.error ?? 'unavailable'}`})
        if (selection.github) {
            messages.push({
                level: 'warn',
                text: '  GitHub Advisories is selected; vulnerabilities can still come from its local advisory cache.',
            })
        } else if (hasGithubToken) {
            messages.push({
                level: 'warn',
                text: '  FALLBACK: GH_TOKEN is set, so vulnerabilities come from the GitHub Advisory\n'
                    + '  database instead. That covers fewer ecosystems and no OS packages, and it\n'
                    + '  matches by advisory range rather than by scanning the SBOM.',
            })
        } else {
            messages.push({
                level: 'warn',
                text: '  VULNERABILITY ANALYSIS IS DISABLED. The vulnerability columns in the CSVs\n'
                    + '  will be empty — that is a missing measurement, not a clean bill of health.\n'
                    + '  Set GH_TOKEN to fall back to the GitHub Advisory database.',
            })
        }
        messages.push({level: 'warn', text: BANNER})
    }

    return messages
}

/**
 * The one-line reminder repeated at the end of the run, where the results paths are printed.
 * Final status from recorded reports; preflight supplies version labels only.
 */
export function scannerSummaryLine(
    preflight: ScannerPreflight,
    hasGithubToken: boolean,
    selection: VulnSourceSelection,
    records: readonly ScannedFileRecord[],
): PreflightMessage {
    const outcome = localScanOutcome(records, selection, hasGithubToken)
    if (outcome.requested.length === 0) {
        return {level: 'info', text: 'Vulnerability data source: GitHub Advisories'}
    }
    const describe = (tool: LocalScanner) => `${tool} ${preflight[tool].version ?? '?'}`
    if (outcome.vulnerabilityAnalysis === 'complete') {
        return {level: 'info', text: `Vulnerability data source: ${outcome.successful.map(describe).join(' + ')}`}
    }
    if (outcome.vulnerabilityAnalysis === 'partial') {
        return {
            level: 'warn',
            text: `Vulnerability data source: ${outcome.successful.map(describe).join(' + ')}`
                + ` - PARTIAL, ${outcome.incomplete.join(' + ')} did not complete every SBOM`,
        }
    }
    if (selection.github) {
        return {level: 'warn', text: 'Vulnerability data source: GitHub Advisories - selected local scanners produced no reports'}
    }
    if (outcome.githubAdvisoryFallback) {
        return {level: 'warn', text: 'Vulnerability data source: GitHub Advisories (fallback) - no selected local scanner produced a report'}
    }
    return {level: 'warn', text: 'Vulnerability data source: NONE - no selected local scanner produced a report'}
}
