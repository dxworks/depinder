import {PROVENANCE_FILE} from './scan-provenance'
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

/**
 * The user-facing verdict, as a list of lines for the caller to log.
 *
 * Kept pure and separate from logging so the exact wording is testable — this is the only place a
 * user learns that vulnerability data is missing, and a run that ends with silently empty columns
 * is the failure mode this exists to prevent.
 */
export function scannerPreflightMessages(preflight: ScannerPreflight, hasGithubToken: boolean): PreflightMessage[] {
    const messages: PreflightMessage[] = []
    const {trivy, grype} = preflight
    const installed = [trivy, grype].filter(it => it.installed)
    const missing = [trivy, grype].filter(it => !it.installed)

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

    if (missing.length === 1) {
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

    if (missing.length === 2) {
        messages.push({level: 'warn', text: BANNER})
        messages.push({level: 'warn', text: 'NO local vulnerability scanner available — neither Trivy nor Grype could be run'})
        for (const gone of missing) messages.push({level: 'warn', text: `  ${gone.tool}: ${gone.error ?? 'unavailable'}`})
        if (hasGithubToken) {
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

/** The one-line reminder repeated at the end of the run, where the results paths are printed. */
export function scannerSummaryLine(preflight: ScannerPreflight, hasGithubToken: boolean): PreflightMessage {
    const installed = [preflight.trivy, preflight.grype].filter(it => it.installed)
    if (installed.length === 2) {
        return {level: 'info', text: `Vulnerability data source: ${installed.map(it => `${it.tool} ${it.version ?? '?'}`).join(' + ')}`}
    }
    if (installed.length === 1) {
        const gone = [preflight.trivy, preflight.grype].find(it => !it.installed) as ScannerStatus
        return {
            level: 'warn',
            text: `Vulnerability data source: ${installed[0].tool} only — PARTIAL, ${gone.tool} was not available`,
        }
    }
    return hasGithubToken
        ? {level: 'warn', text: 'Vulnerability data source: GitHub Advisories (fallback) — no local scanner ran'}
        : {level: 'warn', text: 'Vulnerability data source: NONE — the vulnerability columns are empty because no scanner ran'}
}
