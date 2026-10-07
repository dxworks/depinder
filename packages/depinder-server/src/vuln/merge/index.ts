/**
 * Trivy and Grype findings, unioned into one list per purl. Ported from depinder's
 * `src/plugins/sbom/local-scan.ts`, which does the same for the SBOMs it scans locally; the logic
 * and the comments are kept, so that the server's answer and a local scan stay the same thing.
 *
 * Findings from both tools are unioned and deduplicated by (package, canonical vulnerability id).
 * Where both tools report the same finding, fields merge by strength (measured on the Zeppelin
 * SBOMs): Grype knows the vulnerable range and CVSS score more often, Trivy knows the published
 * timestamp; references and identifiers are unioned.
 *
 * The one change from depinder is how a finding is tied to its package. depinder has real SBOMs
 * and matches findings back through the purl and `name@version` both tools echo (`packageKeys`).
 * Here the SBOM is ours, and each component's `bom-ref` is `c<index>` (`sbom.ts`): both tools echo
 * it, so the ref IS the package, and nothing has to be parsed or normalised to find it. That
 * matters, because the purls they echo are not ours — Trivy lowercases a golang path
 * (`github.com/burntsushi/toml`) and spells a maven name `group:artifact`, Grype gives the bare
 * artifactId.
 *
 * Verified on 2026-10-01 with real Grype 0.118.0 and Trivy 0.74.0 against Phase 0's databases, on a
 * four-component SBOM with refs `c0`..`c3`: every Grype match carried `artifact.id` equal to its
 * component's ref (`c0`, `c1`, `c3`), and every Trivy finding `PkgIdentifier.BOMRef` equal to it.
 * Phase 0's 10,049-purl run, where the refs were the purls, agrees on all 1,326 Grype matches. So
 * `artifact.id` is the main path, and the exact `artifact.purl` fallback is only a safety net for a
 * Grype that some day stops echoing it.
 *
 * Each tool's report shape and parser live in `trivy.ts` and `grype.ts`; this file holds what
 * they produce and the merge.
 */

import {grypeFindings, type GrypeReport} from './grype.js'
import {trivyFindings, type TrivyReport} from './trivy.js'

export type {GrypeReport} from './grype.js'
export type {TrivyReport} from './trivy.js'

// ---------------------------------------------------------------------------
// The finding shape depinder reads.
// ---------------------------------------------------------------------------

/**
 * depinder's `Vulnerability` (`src/extension-points/vulnerability-checker.ts`), copied. It must stay
 * field-for-field identical: this is what the server answers with, and depinder puts it straight
 * into the same places a local scan's findings go.
 */
export interface Vulnerability {
    severity: string
    score?: number
    description: string
    summary?: string
    timestamp?: number
    permalink: string
    identifiers?: { value: string, type: string }[]
    references?: string[]
    vulnerableRange?: string
    vulnerableVersions?: string[]
    firstPatchedVersion?: string
    /**
     * Every fixed version the source named, one per maintained line (`2.15.0`, `2.12.2`).
     * `firstPatchedVersion` is one of them; upgrade guidance needs all of them, because a
     * candidate on the 2.12 line is only fixed by the 2.12 fix, not by the 2.15 one.
     */
    patchedVersions?: string[]
    /**
     * The fields below carry what the Black Duck-shaped security CSV reports and what the CSV
     * columns in `analyse.ts` do not. They are optional and additive: every producer fills what
     * its source knows, and `sbom-security.csv` leaves the rest blank.
     */
    /** Which source produced this finding: 'trivy', 'grype', 'trivy,grype', 'github'. */
    source?: string
    /** The CVSS vector string, e.g. `CVSS:3.1/AV:N/AC:L/...`. */
    cvssVector?: string
    /** The CVSS version the score and vector belong to: '3.0', '3.1', '4.0'. */
    cvssVersion?: string
    cweIds?: string[]
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** CVE id if one is known, else the first id (typically a GHSA) — the cross-tool dedup handle. */
function canonicalId(ids: string[]): string | undefined {
    return ids.find(id => id.toUpperCase().startsWith('CVE-')) ?? ids[0]
}

function identifierType(id: string): string {
    const upper = id.toUpperCase()
    if (upper.startsWith('CVE-')) return 'CVE'
    if (upper.startsWith('GHSA-')) return 'GHSA'
    return 'OTHER'
}

/** One tool's view of one finding, before cross-tool merging. */
export interface RawFinding {
    /** The component's `bom-ref` as the scanner echoed it — identical for both tools. */
    ref: string
    /** Grype only: `artifact.purl`, for when `ref` is not one of ours. See `buildVulnerabilityIndex`. */
    purl?: string
    ids: string[]
    severity?: string
    score?: number
    description?: string
    summary?: string
    timestamp?: number
    permalink?: string
    references: string[]
    vulnerableRange?: string
    firstPatchedVersion?: string
    patchedVersions?: string[]
    /** The exact installed version the scanner matched — the range fallback. */
    installedVersion?: string
    source: string
    cvssVector?: string
    cvssVersion?: string
    cweIds?: string[]
}

// ---------------------------------------------------------------------------
// Cross-tool merge (pure, unit-testable)
// ---------------------------------------------------------------------------

interface VulnerabilityIndex {
    /** Input purl -> its findings. Only purls with at least one finding are in it. */
    index: Map<string, Vulnerability[]>
    /** Findings whose ref was not one of ours, dropped. Should always be 0. */
    unmapped: number
}

/**
 * Unions Trivy and Grype findings into an input-purl -> Vulnerability[] index.
 *
 * `refs` maps each component's `bom-ref` to the purl that was sent for it. `purlRefs` maps each
 * component's SBOM `purl` to its ref, for a Grype match whose `artifact.id` is not a known ref —
 * the safety net described in the file header. A finding that maps to neither is dropped and
 * counted in `unmapped`.
 *
 * Dedup key: (ref, canonical vulnerability id). Field-level merge on collision: Grype's
 * vulnerableRange and score win, Trivy's timestamp wins, references and identifiers union; the
 * remaining fields keep the first non-empty value.
 *
 * Every finding gets a vulnerableRange: Grype's constraint when known, otherwise the exact
 * installed version (`=1.2.3`). The scanners already matched the SBOM's exact version, so a
 * range-filter downstream must never drop these findings.
 */
export function buildVulnerabilityIndex(
    trivy: TrivyReport | undefined,
    grype: GrypeReport | undefined,
    refs: ReadonlyMap<string, string>,
    purlRefs?: ReadonlyMap<string, string>,
): VulnerabilityIndex {
    interface Merged extends RawFinding {
        canonical: string
    }

    const merged = new Map<string, Merged>()
    let unmapped = 0

    const add = (finding: RawFinding, preferIncoming: {range: boolean, score: boolean, timestamp: boolean}) => {
        const canonical = canonicalId(finding.ids)
        if (!canonical) return
        const fallback = finding.purl !== undefined ? purlRefs?.get(finding.purl) : undefined
        const ref = refs.has(finding.ref) ? finding.ref : fallback !== undefined && refs.has(fallback) ? fallback : undefined
        if (ref === undefined) {
            unmapped++
            return
        }
        const key = `${ref}|${canonical.toUpperCase()}`
        const existing = merged.get(key)
        if (!existing) {
            merged.set(key, {...finding, ref, canonical})
            return
        }
        // Union identity and references, merge fields by preference.
        for (const id of finding.ids) {
            if (!existing.ids.some(e => e.toUpperCase() === id.toUpperCase())) existing.ids.push(id)
        }
        for (const reference of finding.references) {
            if (!existing.references.includes(reference)) existing.references.push(reference)
        }
        if (finding.vulnerableRange && (preferIncoming.range || !existing.vulnerableRange)) {
            existing.vulnerableRange = finding.vulnerableRange
        }
        if (finding.score !== undefined && (preferIncoming.score || existing.score === undefined)) {
            existing.score = finding.score
        }
        if (finding.timestamp !== undefined && (preferIncoming.timestamp || existing.timestamp === undefined)) {
            existing.timestamp = finding.timestamp
        }
        existing.severity = existing.severity ?? finding.severity
        existing.description = existing.description || finding.description
        existing.summary = existing.summary || finding.summary
        existing.permalink = existing.permalink || finding.permalink
        existing.firstPatchedVersion = existing.firstPatchedVersion || finding.firstPatchedVersion
        for (const fixed of finding.patchedVersions ?? []) {
            if (!existing.patchedVersions?.includes(fixed)) existing.patchedVersions = [...(existing.patchedVersions ?? []), fixed]
        }
        if (!existing.source.split(',').includes(finding.source)) existing.source += `,${finding.source}`
        if (finding.cvssVector && (preferIncoming.score || !existing.cvssVector)) {
            existing.cvssVector = finding.cvssVector
            existing.cvssVersion = finding.cvssVersion
        }
        if (finding.cweIds?.length && !existing.cweIds?.length) existing.cweIds = finding.cweIds
    }

    if (trivy) {
        for (const f of trivyFindings(trivy)) add(f, {range: false, score: false, timestamp: true})
    }
    if (grype) {
        for (const f of grypeFindings(grype)) add(f, {range: true, score: true, timestamp: false})
    }

    const index = new Map<string, Vulnerability[]>()
    for (const f of merged.values()) {
        const vulnerability: Vulnerability = {
            severity: f.severity ?? 'UNKNOWN',
            score: f.score,
            description: f.description ?? '',
            summary: f.summary,
            timestamp: f.timestamp,
            permalink: f.permalink ?? '',
            identifiers: f.ids.map(id => ({value: id, type: identifierType(id)})),
            references: f.references,
            // The scanners matched the exact installed version, so a missing range must not read
            // as "not vulnerable" downstream — pin it to that version.
            vulnerableRange: f.vulnerableRange ?? (f.installedVersion ? `=${f.installedVersion}` : undefined),
            firstPatchedVersion: f.firstPatchedVersion,
            patchedVersions: f.patchedVersions?.length ? f.patchedVersions : undefined,
            source: f.source,
            cvssVector: f.cvssVector,
            cvssVersion: f.cvssVersion,
            cweIds: f.cweIds,
        }
        // `add` only keeps refs that are in `refs`.
        const purl = refs.get(f.ref)!
        const list = index.get(purl)
        if (list) list.push(vulnerability)
        else index.set(purl, [vulnerability])
    }
    return {index, unmapped}
}
