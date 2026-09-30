/**
 * The shareable Black Duck report shape, in one place.
 *
 * `transformBlackDuckReports` reshapes a real Black Duck export into four `_*.csv` files, and
 * `analyse` writes the same four files from SBOMs. Both import their headers and their
 * cell conventions from here, so the two commands cannot drift into two spellings of one column
 * and a downstream reader can process either folder the same way.
 *
 * This is a leaf module: it knows nothing about the model or the raw export, only about the
 * header lines and the shape of a cell.
 */

/** `_dependencies.csv`: one row per (component, version, origin). */
export const DEPENDENCIES_COLUMNS = [
    'Component name', 'Component version name', 'Version id', 'Component Version Origin Id',
    'License names', 'License families', 'Match type', 'Usage', 'Operational Risk', 'Origin name',
    'License Risk', 'Total Vulnerability Count', 'Critical and High Vulnerability Count',
    'Critical Vulnerability Count', 'High Vulnerability Count', 'Medium Vulnerability Count',
    'Low Vulnerability Count', 'Release Date', 'Newer Versions', 'Commit Activity',
    'Commits in Past 12 Months', 'Contributors in Past 12 Months', 'Has License Conflicts',
    'Component Link', 'Open Hub URL',
] as const

/** `_dependencies_sources.csv`: one row per (component, path). */
export const DEPENDENCIES_SOURCES_COLUMNS = [
    'Component name', 'Component version name', 'Version id', 'Component Version Origin Id',
    'Match type', 'Path', 'ProjectPath', 'VerifiedPath', 'VerifiedPathMethod', 'Origin name',
    'License names', 'License families', 'License Risk', 'Critical Vulnerability Count',
    'High Vulnerability Count', 'Medium Vulnerability Count', 'Low Vulnerability Count',
    'Total Vulnerability Count', 'Critical and High Vulnerability Count', 'Operational Risk',
    'Release Date', 'Newer Versions', 'OpenHubURL',
] as const

/** `_vulnerability_details.csv`: one row per (component, advisory), without Black Duck's ids and triage. */
export const VULNERABILITY_DETAILS_COLUMNS = [
    'Component name', 'Component version name', 'Component Version Origin Id', 'Vulnerability id',
    'Description', 'Published on', 'Updated on', 'Base score', 'Exploitability', 'Impact',
    'Vulnerability source', 'Remediation status', 'URL', 'Security Risk', 'Project path',
    'Overall score', 'CWE Ids', 'Solution available', 'Workaround available', 'Exploit available',
    'CVSS Version', 'Match type', 'Vulnerability tags',
] as const

/** `_upgrade_guidance.csv`: one row per component with a finding. */
export const UPGRADE_GUIDANCE_COLUMNS = [
    'Component Name', 'Component Version Name', 'Component Origin Name',
    'Component Version Origin Id', 'Total Known Vulnerabilities',
    'Short Term Recommended Version Name', 'Short Term Recommended Origin Name',
    'Short Term Recommended Origin Id', 'Short Term Recommended Origin Version Name',
    'Short Term Critical Vulnerability', 'Short Term High Vulnerability',
    'Short Term Medium Vulnerability', 'Short Term Low Vulnerability',
    'Long Term Recommended Version Name', 'Long Term Recommended Origin Name',
    'Long Term Recommended Origin Id', 'Long Term Recommended Origin Version Name',
    'Long Term Critical Vulnerability', 'Long Term High Vulnerability',
    'Long Term Medium Vulnerability', 'Long Term Low Vulnerability',
] as const

/**
 * `_component_versions.csv`: ours, not Black Duck's. The registry facts behind `Newer Versions`,
 * plus the count by version number that has no Black Duck column.
 */
export const COMPONENT_VERSIONS_COLUMNS = [
    'Component name', 'Component version name', 'Component Version Origin Id', 'Origin name',
    'Release Date', 'Newer Versions', 'Newer Versions (semver)',
] as const

/** `Direct Dependency` → `Direct`; `Direct Dependency,Transitive Dependency` → `Direct,Transitive`. */
export function normalizeMatchType(matchType: string): string {
    return (matchType || '').replace(/ Dependency/g, '')
}

/**
 * A date cell: `\tYYYY-MM-DD`. The leading tab keeps Excel from re-reading the ISO date as a
 * locale date on open. Empty stays empty.
 */
export function isoToTabIso(iso: string): string {
    return iso ? `\t${iso}` : ''
}

/**
 * Black Duck's `M/D/YY` (`7/24/26`) → `\tYYYY-MM-DD`. A two-digit year below 50 is 20xx. Anything
 * that is not three slash-separated numbers is written empty.
 */
export function blackDuckDateToTabIso(raw: string): string {
    if (!raw) return ''
    const parts = raw.trim().split('/')
    if (parts.length !== 3) return ''
    const [month, day, year] = parts.map(s => parseInt(s, 10))
    if (isNaN(month) || isNaN(day) || isNaN(year)) return ''
    const fullYear = year < 50 ? 2000 + year : 1900 + year
    return isoToTabIso(`${fullYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
}

/**
 * A per-severity vulnerability count: blank when zero, the way Black Duck leaves the cell.
 * `Total Vulnerability Count` and `Critical and High Vulnerability Count` do not use this — they
 * are always written as a number.
 */
export function countCell(count: number): string {
    return count > 0 ? String(count) : ''
}
