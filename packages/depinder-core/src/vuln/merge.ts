/**
 * Trivy and Grype findings, unioned and deduplicated by (package, canonical vulnerability id).
 * Where both tools report the same finding, fields merge by strength: Grype knows the vulnerable
 * range and CVSS score more often, Trivy knows the published timestamp; references and
 * identifiers are unioned.
 */

import {grypeFindings, type GrypeReport} from './grype.js'
import {trivyFindings, type TrivyReport} from './trivy.js'
import type {RawFinding, ScannedPackage, Vulnerability} from './vulnerability.js'

/** Where a scanned package's findings go: one merge key, listed under every index key. */
interface PackageKeys {
    /** Both tools' findings for one package must get the same merge key. */
    mergeKey: string
    indexKeys: string[]
}

/** Ties a scanned package to the caller's keys; `undefined` drops its findings as unmapped. */
export type PackageKeyer = (scanned: ScannedPackage) => PackageKeys | undefined

export interface VulnerabilityIndex {
    /** Index key -> its findings. Only keys with at least one finding are in it. */
    index: Map<string, Vulnerability[]>
    /** Findings the keyer could not place, dropped. */
    unmapped: number
}

/** Which tool's value wins when both tools report a field. */
interface Preference {
    range: boolean
    score: boolean
    timestamp: boolean
}

const TRIVY_PREFERENCE: Preference = {range: false, score: false, timestamp: true}
const GRYPE_PREFERENCE: Preference = {range: true, score: true, timestamp: false}

interface MergedFinding extends RawFinding {
    indexKeys: string[]
}

/** CVE id if one is known, else the first id (typically a GHSA): the cross-tool dedup handle. */
function canonicalId(ids: string[]): string | undefined {
    return ids.find(id => id.toUpperCase().startsWith('CVE-')) ?? ids[0]
}

function identifierType(id: string): string {
    const upper = id.toUpperCase()
    if (upper.startsWith('CVE-')) return 'CVE'
    if (upper.startsWith('GHSA-')) return 'GHSA'
    return 'OTHER'
}

/** Folds a second tool's view of the same finding into `existing`. */
function mergeFinding(existing: MergedFinding, finding: RawFinding, indexKeys: string[], prefer: Preference): void {
    for (const key of indexKeys) {
        if (!existing.indexKeys.includes(key)) existing.indexKeys.push(key)
    }
    for (const id of finding.ids) {
        if (!existing.ids.some(e => e.toUpperCase() === id.toUpperCase())) existing.ids.push(id)
    }
    for (const reference of finding.references) {
        if (!existing.references.includes(reference)) existing.references.push(reference)
    }
    if (finding.vulnerableRange && (prefer.range || !existing.vulnerableRange)) {
        existing.vulnerableRange = finding.vulnerableRange
    }
    if (finding.score !== undefined && (prefer.score || existing.score === undefined)) {
        existing.score = finding.score
    }
    if (finding.timestamp !== undefined && (prefer.timestamp || existing.timestamp === undefined)) {
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
    if (finding.cvssVector && (prefer.score || !existing.cvssVector)) {
        existing.cvssVector = finding.cvssVector
        existing.cvssVersion = finding.cvssVersion
    }
    if (finding.cweIds?.length && !existing.cweIds?.length) existing.cweIds = finding.cweIds
}

function toVulnerability(f: MergedFinding): Vulnerability {
    const installed = f.package.version
    return {
        severity: f.severity ?? 'UNKNOWN',
        score: f.score,
        description: f.description ?? '',
        summary: f.summary,
        timestamp: f.timestamp,
        permalink: f.permalink ?? '',
        identifiers: f.ids.map(id => ({value: id, type: identifierType(id)})),
        references: f.references,
        // The scanners matched the exact installed version: pin a missing range to it, so no
        // range filter downstream reads it as "not vulnerable".
        vulnerableRange: f.vulnerableRange ?? (installed ? `=${installed}` : undefined),
        firstPatchedVersion: f.firstPatchedVersion,
        patchedVersions: f.patchedVersions?.length ? f.patchedVersions : undefined,
        source: f.source,
        cvssVector: f.cvssVector,
        cvssVersion: f.cvssVersion,
        cweIds: f.cweIds,
    }
}

/**
 * Unions Trivy and Grype findings into an index-key -> Vulnerability[] index. `keyPackage` decides
 * which package a finding belongs to (the CLI: purl and name@version; the server: the bom-ref).
 */
export function buildVulnerabilityIndex(
    trivy: TrivyReport | undefined,
    grype: GrypeReport | undefined,
    keyPackage: PackageKeyer,
): VulnerabilityIndex {
    const merged = new Map<string, MergedFinding>()
    let unmapped = 0

    const add = (finding: RawFinding, prefer: Preference) => {
        const canonical = canonicalId(finding.ids)
        if (!canonical) return
        const keys = keyPackage(finding.package)
        if (!keys) {
            unmapped++
            return
        }
        const mergeKey = `${keys.mergeKey}|${canonical.toUpperCase()}`
        const existing = merged.get(mergeKey)
        if (existing) mergeFinding(existing, finding, keys.indexKeys, prefer)
        else merged.set(mergeKey, {...finding, indexKeys: [...keys.indexKeys]})
    }

    for (const finding of trivy ? trivyFindings(trivy) : []) add(finding, TRIVY_PREFERENCE)
    for (const finding of grype ? grypeFindings(grype) : []) add(finding, GRYPE_PREFERENCE)

    const index = new Map<string, Vulnerability[]>()
    for (const finding of merged.values()) {
        const vulnerability = toVulnerability(finding)
        for (const key of finding.indexKeys) {
            const list = index.get(key)
            if (list) list.push(vulnerability)
            else index.set(key, [vulnerability])
        }
    }
    return {index, unmapped}
}
