import type {RawFinding} from './vulnerability.js'

type GrypeCvss = {source?: string, version?: string, vector?: string, metrics?: {baseScore?: number}}

/** A Grype JSON report: only the fields we read. */
export interface GrypeReport {
    matches?: {
        vulnerability?: {
            id?: string
            severity?: string
            description?: string
            dataSource?: string
            urls?: string[]
            cvss?: GrypeCvss[]
            fix?: { versions?: string[] }
        }
        relatedVulnerabilities?: {
            id?: string
            description?: string
            dataSource?: string
            urls?: string[]
            cvss?: GrypeCvss[]
        }[]
        matchDetails?: { found?: { versionConstraint?: string } }[]
        /** `id` is the SBOM component's `bom-ref`; `name` is the bare maven artifactId. */
        artifact?: { id?: string, name?: string, version?: string, purl?: string }
    }[]
}

type GrypeMatch = NonNullable<GrypeReport['matches']>[number]

/**
 * GHSA's own score first (the GHSA record's block, or an entry sourced from GitHub), then NVD's
 * (on the related CVE record), then any score. Within a group the newest CVSS version wins.
 */
function chooseCvss(vulnerabilityId: string, match: GrypeMatch): GrypeCvss | undefined {
    const scored = (list: GrypeCvss[] | undefined) => (list ?? []).filter(c => c.metrics?.baseScore !== undefined)
    const own = scored(match.vulnerability?.cvss)
    const all = [...own, ...(match.relatedVulnerabilities ?? []).flatMap(r => scored(r.cvss))]
    const isGithub = (c: GrypeCvss) => (c.source ?? '').toLowerCase().includes('github')
    const isNvd = (c: GrypeCvss) => (c.source ?? '').toLowerCase().includes('nvd')
    const newest = (list: GrypeCvss[]): GrypeCvss | undefined =>
        [...list].sort((a, b) => parseFloat(b.version ?? '0') - parseFloat(a.version ?? '0'))[0]
    return newest(all.filter(isGithub))
        ?? (vulnerabilityId.toUpperCase().startsWith('GHSA-') ? newest(own) : undefined)
        ?? newest(all.filter(isNvd))
        ?? newest(all)
}

export function grypeFindings(report: GrypeReport): RawFinding[] {
    const findings: RawFinding[] = []
    for (const match of report.matches ?? []) {
        const vuln = match.vulnerability
        const artifact = match.artifact
        if (!vuln?.id) continue

        const related = match.relatedVulnerabilities ?? []
        const ids = [vuln.id, ...related.map(r => r.id).filter((id): id is string => !!id)]
        const chosenCvss = chooseCvss(vuln.id, match)

        // GHSA records often have an empty description; the related CVE record has one.
        const description = vuln.description || related.find(r => r.description)?.description

        // Constraints carry a version-format suffix, e.g. '>=2.4,<2.12.2 (unknown)'.
        const constraints = (match.matchDetails ?? [])
            .map(d => d.found?.versionConstraint?.replace(/\s*\([^)]*\)\s*$/, ''))
            .filter((c): c is string => !!c && c !== 'none')

        findings.push({
            package: {ref: artifact?.id, purl: artifact?.purl, name: artifact?.name, version: artifact?.version},
            ids,
            severity: vuln.severity?.toUpperCase(),
            score: chosenCvss?.metrics?.baseScore,
            description,
            permalink: vuln.dataSource ?? vuln.urls?.[0],
            references: [
                ...(vuln.urls ?? []),
                ...related.flatMap(r => r.urls ?? []),
            ],
            vulnerableRange: constraints[0],
            firstPatchedVersion: vuln.fix?.versions?.[0],
            patchedVersions: vuln.fix?.versions?.filter(Boolean),
            source: 'grype',
            cvssVector: chosenCvss?.vector,
            cvssVersion: chosenCvss?.version,
        })
    }
    return findings
}
