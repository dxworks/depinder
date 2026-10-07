import type {RawFinding} from './index.js'

// ---------------------------------------------------------------------------
// Scanner output model — only the fields we read.
// ---------------------------------------------------------------------------

export interface GrypeReport {
    matches?: {
        vulnerability?: {
            id?: string
            severity?: string
            description?: string
            dataSource?: string
            urls?: string[]
            cvss?: { source?: string, version?: string, vector?: string, metrics?: { baseScore?: number } }[]
            fix?: { versions?: string[] }
        }
        relatedVulnerabilities?: {
            id?: string
            description?: string
            dataSource?: string
            urls?: string[]
            cvss?: { source?: string, version?: string, vector?: string, metrics?: { baseScore?: number } }[]
        }[]
        matchDetails?: { found?: { versionConstraint?: string } }[]
        /** `id` is the component's `bom-ref`: the package, see the header of `index.ts`. */
        artifact?: { id?: string, name?: string, version?: string, purl?: string }
    }[]
}

// ---------------------------------------------------------------------------
// Parser (pure, unit-testable)
// ---------------------------------------------------------------------------

export function grypeFindings(report: GrypeReport): RawFinding[] {
    const findings: RawFinding[] = []
    for (const match of report.matches ?? []) {
        const vuln = match.vulnerability
        const artifact = match.artifact
        if (!vuln?.id) continue

        const related = match.relatedVulnerabilities ?? []
        const ids = [vuln.id, ...related.map(r => r.id).filter((id): id is string => !!id)]

        // GHSA's own score first (the GHSA record's block, or an entry sourced from GitHub), then
        // NVD's — which sits on the related CVE record, not on the GHSA one — then any score.
        type GrypeCvss = {source?: string, version?: string, vector?: string, metrics?: {baseScore?: number}}
        const scored = (list: GrypeCvss[] | undefined) => (list ?? []).filter(c => c.metrics?.baseScore !== undefined)
        const own = scored(vuln.cvss)
        const all = [...own, ...related.flatMap(r => scored(r.cvss))]
        const isGithub = (c: GrypeCvss) => (c.source ?? '').toLowerCase().includes('github')
        const isNvd = (c: GrypeCvss) => (c.source ?? '').toLowerCase().includes('nvd')
        // Within a group, the newest CVSS version wins (4.0 over 3.1 over 2.0), as on the trivy side.
        const newest = (list: GrypeCvss[]): GrypeCvss | undefined =>
            [...list].sort((a, b) => parseFloat(b.version ?? '0') - parseFloat(a.version ?? '0'))[0]
        const chosenCvss = newest(all.filter(isGithub))
            ?? (vuln.id.toUpperCase().startsWith('GHSA-') ? newest(own) : undefined)
            ?? newest(all.filter(isNvd))
            ?? newest(all)
        const score = chosenCvss?.metrics?.baseScore

        // Grype GHSA records often have an empty description; the related CVE record has one.
        const description = vuln.description || related.find(r => r.description)?.description

        // Grype suffixes constraints with the version format, e.g. '>=2.4,<2.12.2 (unknown)'.
        const constraints = (match.matchDetails ?? [])
            .map(d => d.found?.versionConstraint?.replace(/\s*\([^)]*\)\s*$/, ''))
            .filter((c): c is string => !!c && c !== 'none')

        findings.push({
            ref: artifact?.id ?? '',
            purl: artifact?.purl,
            ids,
            severity: vuln.severity?.toUpperCase(),
            score,
            description,
            permalink: vuln.dataSource ?? vuln.urls?.[0],
            references: [
                ...(vuln.urls ?? []),
                ...related.flatMap(r => r.urls ?? []),
            ],
            vulnerableRange: constraints[0],
            firstPatchedVersion: vuln.fix?.versions?.[0],
            patchedVersions: vuln.fix?.versions?.filter(Boolean),
            installedVersion: artifact?.version,
            source: 'grype',
            cvssVector: chosenCvss?.vector,
            cvssVersion: chosenCvss?.version,
        })
    }
    return findings
}
