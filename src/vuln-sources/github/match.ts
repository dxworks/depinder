import {Vulnerability} from '../../extension-points/vulnerability-checker'
import {cvssOf, GithubAdvisory, identifiersOf, severityOf} from './advisory'
import {ecosystemByName, ecosystemForPurlType, normalizeName} from './ecosystems'
import {satisfiesRange} from './ranges'
import {comparatorFor} from './versions'

/**
 * Matching SBOM components against cached GitHub advisories.
 *
 * The shape of the problem: an advisory names one or more (ecosystem, package, version range)
 * triples, and an SBOM component is one (purl type, name, version). So the index is keyed by
 * (ecosystem, normalised name) and the version test is the only work left at query time.
 *
 * The result is the same internal finding model `local-scan.ts` produces, so the `Vulnerabilities`
 * and `Vulnerability Details` CSV columns are filled identically whichever source ran.
 */

export const GITHUB_SOURCE = 'github'

export interface AdvisoryIndex {
    /** (ecosystem, normalised name) -> the advisory entries naming that package. */
    entries: Map<string, IndexedEntry[]>
    advisoryCount: number
}

interface IndexedEntry {
    advisory: GithubAdvisory
    ecosystem: string
    range?: string
    firstPatchedVersion?: string
}

function keyOf(ecosystem: string, name: string): string {
    return `${ecosystem}|${normalizeName(ecosystem, name)}`
}

/**
 * Builds the lookup index. Withdrawn advisories are dropped: GitHub keeps them in the feed with a
 * `withdrawn_at` timestamp, and reporting one is a false positive by the publisher's own account.
 */
export function buildAdvisoryIndex(advisories: GithubAdvisory[]): AdvisoryIndex {
    const entries = new Map<string, IndexedEntry[]>()
    let advisoryCount = 0
    for (const advisory of advisories) {
        if (advisory.withdrawn_at) continue
        advisoryCount++
        for (const affected of advisory.vulnerabilities ?? []) {
            const ecosystem = affected.package?.ecosystem?.toLowerCase()
            const name = affected.package?.name
            if (!ecosystem || !name) continue
            const key = keyOf(ecosystem, name)
            const entry: IndexedEntry = {
                advisory,
                ecosystem,
                range: affected.vulnerable_version_range ?? undefined,
                firstPatchedVersion: affected.first_patched_version ?? undefined,
            }
            const list = entries.get(key)
            if (list) list.push(entry)
            else entries.set(key, [entry])
        }
    }
    return {entries, advisoryCount}
}

function toVulnerability(entry: IndexedEntry): Vulnerability {
    const {advisory} = entry
    const cvss = cvssOf(advisory)
    const published = advisory.published_at ? Date.parse(advisory.published_at) : NaN
    return {
        severity: severityOf(advisory),
        score: cvss.score,
        description: advisory.description ?? '',
        summary: advisory.summary,
        timestamp: Number.isNaN(published) ? undefined : published,
        permalink: advisory.html_url ?? `https://github.com/advisories/${advisory.ghsa_id}`,
        identifiers: identifiersOf(advisory),
        references: advisory.references ?? [],
        vulnerableRange: entry.range,
        firstPatchedVersion: entry.firstPatchedVersion,
        source: GITHUB_SOURCE,
        cvssVector: cvss.vector,
        cvssVersion: cvss.version,
        cweIds: (advisory.cwes ?? []).map(it => it.cwe_id).filter((it): it is string => !!it),
    }
}

/**
 * The advisories affecting one component.
 *
 * `ecosystem` accepts either vocabulary — a GitHub ecosystem name or a purl type — because the
 * callers come from both sides: the CLI speaks GitHub names, an SBOM speaks purl types.
 *
 * An advisory entry with no `vulnerable_version_range` at all affects every version of the
 * package; GitHub emits this rarely and it is the publisher's own statement, so it is honoured.
 * A range that cannot be parsed is treated as not matching — see `ranges.ts`.
 */
export function matchComponent(index: AdvisoryIndex, ecosystem: string, name: string, version: string): Vulnerability[] {
    const resolved = ecosystemByName(ecosystem) ?? ecosystemForPurlType(ecosystem)
    if (!resolved) return []
    const candidates = index.entries.get(keyOf(resolved.name, name)) ?? []
    if (candidates.length === 0) return []

    const compare = comparatorFor(resolved.comparator)
    const found = new Map<string, Vulnerability>()
    for (const entry of candidates) {
        if (entry.range && !satisfiesRange(version, entry.range, compare)) continue
        // One advisory can list several disjoint ranges for the same package; only one of them can
        // contain this version, but keying by GHSA id makes that structural rather than assumed.
        if (!found.has(entry.advisory.ghsa_id)) found.set(entry.advisory.ghsa_id, toVulnerability(entry))
    }
    return [...found.values()]
}
