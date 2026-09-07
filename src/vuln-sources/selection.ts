/**
 * Which vulnerability sources a run uses.
 *
 * `--vuln-source` accepts a comma-separated list of `trivy`, `grype`, `github` and `all`. The
 * default is `trivy,grype`: exactly what depinder did before this option existed, so an existing
 * command line keeps producing an identical libs.csv.
 *
 * The selection is process-wide rather than threaded through every call. The SBOM parser is
 * reached through the Plugin interface, which carries no options, and both scan paths are already
 * memoised per process for the same reason — so this joins the state that is already there rather
 * than inventing a parallel channel.
 */

export interface VulnSourceSelection {
    trivy: boolean
    grype: boolean
    github: boolean
}

export const DEFAULT_VULN_SOURCE = 'trivy,grype'

export const ALL_SOURCES: VulnSourceSelection = {trivy: true, grype: true, github: true}

export class UnknownVulnSourceError extends Error {
    constructor(name: string) {
        super(`Unknown --vuln-source '${name}'. Expected a comma-separated list of: trivy, grype, github, all.`)
        this.name = 'UnknownVulnSourceError'
    }
}

export function parseVulnSources(value: string): VulnSourceSelection {
    const selection: VulnSourceSelection = {trivy: false, grype: false, github: false}
    for (const raw of value.split(',')) {
        const name = raw.trim().toLowerCase()
        if (!name) continue
        if (name === 'all') Object.assign(selection, ALL_SOURCES)
        else if (name === 'trivy' || name === 'grype' || name === 'github') selection[name] = true
        else throw new UnknownVulnSourceError(raw.trim())
    }
    if (!selection.trivy && !selection.grype && !selection.github) throw new UnknownVulnSourceError(value)
    return selection
}

let current: VulnSourceSelection = parseVulnSources(DEFAULT_VULN_SOURCE)

export function setVulnSources(selection: VulnSourceSelection): void {
    current = selection
}

export function vulnSources(): VulnSourceSelection {
    return current
}

/** Exposed for tests, and for any caller that needs the default back. */
export function resetVulnSources(): void {
    current = parseVulnSources(DEFAULT_VULN_SOURCE)
}

export function describeVulnSources(selection: VulnSourceSelection = current): string {
    return (['trivy', 'grype', 'github'] as const).filter(it => selection[it]).join(', ')
}
