import type {ScannedFileRecord} from './scan-provenance'
import type {VulnSourceSelection} from '../../vuln-sources/selection'

export type LocalScanner = 'trivy' | 'grype'

export interface LocalScanOutcome {
    /** The selected local scanners the run asked for. */
    requested: LocalScanner[]
    /** Requested scanners that produced a report on at least one file. */
    successful: LocalScanner[]
    /** Requested scanners that did not produce a report on every file (or there were no files). */
    incomplete: LocalScanner[]
    githubAdvisoryFallback: boolean
    vulnerabilityAnalysis: 'complete' | 'partial' | 'github-advisories-only' | 'disabled'
}

/**
 * Classifies selected scanner reports, not installed binaries.
 * GitHub-only/fallback name advisory modes, not coverage guarantees.
 */
export function localScanOutcome(
    files: readonly Pick<ScannedFileRecord, 'trivy' | 'grype'>[],
    selection: VulnSourceSelection,
    hasGithubToken: boolean,
): LocalScanOutcome {
    const requested = (['trivy', 'grype'] as const).filter(tool => selection[tool])
    const successful = requested.filter(tool => files.some(file => file[tool] === 'ok'))
    const incomplete = requested.filter(tool => files.length === 0 || files.some(file => file[tool] !== 'ok'))
    const localScanSucceeded = successful.length > 0
    const complete = requested.length > 0 && files.length > 0 && incomplete.length === 0
    const githubAdvisoryFallback = !localScanSucceeded && !selection.github && hasGithubToken
    const vulnerabilityAnalysis = complete ? 'complete'
        : localScanSucceeded ? 'partial'
            : selection.github || githubAdvisoryFallback ? 'github-advisories-only' : 'disabled'
    return {requested, successful, incomplete, githubAdvisoryFallback, vulnerabilityAnalysis}
}
