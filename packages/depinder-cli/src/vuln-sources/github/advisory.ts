/**
 * The GitHub global security advisory, as returned by `GET /advisories` — only the fields this
 * source reads, so an API addition cannot break parsing.
 *
 * Note the two levels of identity. The advisory has one `ghsa_id` and at most one `cve_id`, while
 * `identifiers[]` carries both plus any others; and `vulnerabilities[]` holds ONE ENTRY PER
 * (package, version range) pair, so a single advisory can name several packages and several
 * disjoint ranges of the same package.
 */
export interface GithubAdvisory {
    ghsa_id: string
    cve_id?: string | null
    html_url?: string
    summary?: string
    description?: string
    /** `critical` | `high` | `medium` | `low` | `unknown`, lowercase in the API. */
    severity?: string
    published_at?: string
    updated_at?: string
    withdrawn_at?: string | null
    identifiers?: {value: string, type: string}[]
    references?: string[]
    cvss?: {vector_string?: string | null, score?: number | null} | null
    /** Added 2024; holds v3 and v4 side by side. `cvss` remains the v3 view. */
    cvss_severities?: {
        cvss_v3?: {vector_string?: string | null, score?: number | null} | null
        cvss_v4?: {vector_string?: string | null, score?: number | null} | null
    } | null
    cwes?: {cwe_id?: string, name?: string}[]
    vulnerabilities?: {
        package?: {ecosystem?: string, name?: string}
        vulnerable_version_range?: string | null
        first_patched_version?: string | null
    }[]
}

/**
 * The CVSS view to report: prefer v3 (what every other source in depinder reports), else v4.
 *
 * An unscored advisory is not absent from these fields — GitHub fills them with
 * `{vector_string: null, score: 0}`, which is why a falsy score reads as "no CVSS" rather than as
 * a genuine 0.0. Measured on the live rubygems feed: 372 of 1,150 advisories are unscored, and
 * every one of them has exactly that shape.
 */
export function cvssOf(advisory: GithubAdvisory): {score?: number, vector?: string, version?: string} {
    const v3 = advisory.cvss_severities?.cvss_v3 ?? advisory.cvss
    if (v3?.vector_string || v3?.score) {
        return {
            score: v3.score ?? undefined,
            vector: v3.vector_string ?? undefined,
            version: v3.vector_string?.startsWith('CVSS:3.0') ? '3.0' : '3.1',
        }
    }
    const v4 = advisory.cvss_severities?.cvss_v4
    if (v4?.vector_string || v4?.score) {
        return {score: v4.score ?? undefined, vector: v4.vector_string ?? undefined, version: '4.0'}
    }
    return {}
}

/**
 * GitHub writes severity lowercase and calls the middle band `medium`; depinder's CSVs and both
 * local scanners use the uppercase OSV/NVD spelling.
 */
export function severityOf(advisory: GithubAdvisory): string {
    const severity = advisory.severity?.toUpperCase()
    if (!severity) return 'UNKNOWN'
    return severity === 'MODERATE' ? 'MEDIUM' : severity
}

/** Every id this advisory is known by, GHSA first — the order the finding model expects. */
export function identifiersOf(advisory: GithubAdvisory): {value: string, type: string}[] {
    const seen = new Set<string>()
    const ids: {value: string, type: string}[] = []
    const push = (value: string | undefined | null, type: string) => {
        if (!value) return
        const key = value.toUpperCase()
        if (seen.has(key)) return
        seen.add(key)
        ids.push({value, type})
    }
    push(advisory.ghsa_id, 'GHSA')
    push(advisory.cve_id, 'CVE')
    for (const id of advisory.identifiers ?? []) push(id.value, id.type?.toUpperCase() ?? 'OTHER')
    return ids
}
