import type {RawFinding} from './index.js'

// ---------------------------------------------------------------------------
// Scanner output model — only the fields we read.
// ---------------------------------------------------------------------------

export interface TrivyReport {
    Results?: {
        Vulnerabilities?: {
            VulnerabilityID?: string
            /** Aliases from the advisory source, e.g. the GHSA id when the CVE is primary. */
            VendorIDs?: string[]
            PkgName?: string
            InstalledVersion?: string
            /** `BOMRef` is the component's `bom-ref`: the package, see the header of `index.ts`. */
            PkgIdentifier?: { PURL?: string, BOMRef?: string }
            FixedVersion?: string
            Severity?: string
            Title?: string
            Description?: string
            PrimaryURL?: string
            References?: string[]
            PublishedDate?: string
            CweIDs?: string[]
            CVSS?: { [source: string]: { V40Score?: number, V3Score?: number, V2Score?: number, V40Vector?: string, V3Vector?: string, V2Vector?: string } }
        }[]
    }[]
}

// ---------------------------------------------------------------------------
// Parser (pure, unit-testable)
// ---------------------------------------------------------------------------

/** `2.15.0, 2.12.2` -> `['2.15.0', '2.12.2']`; empty and blank cells give `undefined`. */
function fixedVersions(cell: string | undefined): string[] | undefined {
    const versions = (cell ?? '').split(',').map(it => it.trim()).filter(Boolean)
    return versions.length > 0 ? versions : undefined
}

type TrivyCvss = NonNullable<NonNullable<NonNullable<TrivyReport['Results']>[number]['Vulnerabilities']>[number]['CVSS']>

interface ChosenCvss {
    score?: number
    cvssVector?: string
    cvssVersion?: string
}

/**
 * Trivy reports one CVSS block per scoring source (`ghsa`, `nvd`, `redhat`, …). GHSA's block wins
 * — it is the catalogue that knows the package, and the one our ids are named after — then NVD's,
 * then whatever else scores highest. Within a block the newest CVSS wins: `V40Score` (trivy 0.6x+;
 * older reports put a `CVSS:4.0` vector under `V3Vector`), then `V3Score`, then `V2Score`. Score
 * and vector always come from the same block, so they agree.
 */
export function trivyCvss(cvss: TrivyCvss | undefined): ChosenCvss {
    const entries = Object.entries(cvss ?? {})
    const fromBlock = (entry: TrivyCvss[string]): ChosenCvss | undefined => {
        if (entry.V40Score !== undefined) return {score: entry.V40Score, cvssVector: entry.V40Vector, cvssVersion: '4.0'}
        if (entry.V3Score !== undefined) {
            return {score: entry.V3Score, cvssVector: entry.V3Vector,
                cvssVersion: entry.V3Vector?.startsWith('CVSS:4') ? '4.0' : entry.V3Vector?.startsWith('CVSS:3.0') ? '3.0' : '3.1'}
        }
        if (entry.V2Score !== undefined) return {score: entry.V2Score, cvssVector: entry.V2Vector, cvssVersion: '2.0'}
        return undefined
    }
    for (const preferred of ['ghsa', 'nvd']) {
        const block = entries.find(([source]) => source.toLowerCase() === preferred)?.[1]
        const chosen = block && fromBlock(block)
        if (chosen) return chosen
    }
    let chosen: ChosenCvss = {}
    for (const [, entry] of entries) {
        const candidate = fromBlock(entry)
        if (candidate?.score !== undefined && (chosen.score === undefined || candidate.score > chosen.score)) chosen = candidate
    }
    return chosen
}

export function trivyFindings(report: TrivyReport): RawFinding[] {
    const findings: RawFinding[] = []
    for (const result of report.Results ?? []) {
        for (const vuln of result.Vulnerabilities ?? []) {
            if (!vuln.VulnerabilityID) continue

            const {score, cvssVector, cvssVersion} = trivyCvss(vuln.CVSS)

            const timestamp = vuln.PublishedDate ? Date.parse(vuln.PublishedDate) : NaN
            findings.push({
                // A finding with no ref is kept, and dropped as unmapped where it is counted.
                ref: vuln.PkgIdentifier?.BOMRef ?? '',
                ids: [vuln.VulnerabilityID, ...(vuln.VendorIDs ?? [])],
                severity: vuln.Severity?.toUpperCase(),
                score,
                description: vuln.Description,
                summary: vuln.Title,
                timestamp: Number.isNaN(timestamp) ? undefined : timestamp,
                permalink: vuln.PrimaryURL,
                references: vuln.References ?? [],
                // Trivy reports no vulnerable range against an SBOM, only the fix versions — one
                // per maintained line, highest first (`2.15.0, 2.12.2`). All of them are kept.
                firstPatchedVersion: vuln.FixedVersion?.split(',')[0]?.trim() || undefined,
                patchedVersions: fixedVersions(vuln.FixedVersion),
                installedVersion: vuln.InstalledVersion,
                source: 'trivy',
                cvssVector,
                cvssVersion,
                cweIds: vuln.CweIDs,
            })
        }
    }
    return findings
}
