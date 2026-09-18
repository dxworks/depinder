import fs from 'fs'
import path from 'path'
import {cvss3SubScores} from './cvss'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {csvDocument, NamedRow} from '../utils/csv'
import {log} from '../utils/logging'
import {
    COMPONENT_VERSIONS_COLUMNS, countCell, DEPENDENCIES_COLUMNS, DEPENDENCIES_SOURCES_COLUMNS, isoToTabIso,
    normalizeMatchType, UPGRADE_GUIDANCE_COLUMNS, VULNERABILITY_DETAILS_COLUMNS,
} from './columns'
import {licenseColumns, licenseRisk} from './licenses'
import {operationalRisk} from './risk'
import {BlackDuckModel, ExportComponent, ExportFinding} from './model'
import {componentLink, originId} from './origins'
import {remainingAt, upgradeGuidance} from './upgrade'

/**
 * The Black Duck-shaped CSVs, written from one model.
 *
 * The four shareable files — `_dependencies.csv`, `_dependencies_sources.csv`,
 * `_vulnerability_details.csv`, `_upgrade_guidance.csv` — carry the header line and the cell
 * conventions `transformBlackDuckReports` writes from a real Black Duck export (`columns.ts`,
 * shared with it), so a downstream reader processes either folder the same way. `security.csv`
 * keeps Black Duck's raw `security_*.csv` header, byte for byte; `_dependency_edges.csv` and
 * `_component_versions.csv` are ours.
 *
 * Columns we cannot fill are written empty rather than guessed. Which ones, and why, is in the
 * README's column-mapping table.
 */

const DEPENDENCIES_FILE = '_dependencies.csv'
const DEPENDENCIES_SOURCES_FILE = '_dependencies_sources.csv'
const DEPENDENCY_EDGES_FILE = '_dependency_edges.csv'
const UPGRADE_GUIDANCE_FILE = '_upgrade_guidance.csv'
const SECURITY_FILE = 'security.csv'
const VULNERABILITY_DETAILS_FILE = '_vulnerability_details.csv'
const COMPONENT_VERSIONS_FILE = '_component_versions.csv'
const VULNERABILITY_FINDINGS_FILE = '_vulnerability_findings.json'

/**
 * Not a Black Duck file — Black Duck has no such export. `_dependencies_sources.csv` keeps one
 * `Path` per component, the way Black Duck does, which is a chain and not the graph: a component
 * with three parents keeps one of them. This is the graph, so a tree can be compared against
 * ground truth edge for edge rather than package for package.
 */
const DEPENDENCY_EDGES_HEADERS = [
    'Repo', 'Tree', 'Ecosystem', 'Parent Origin Id', 'Child Origin Id', 'Child Depth',
] as const

/**
 * `security.csv`: Black Duck's `security_*.csv` header, byte for byte, so the two diff directly.
 * The internal ids, the triage workflow fields and the CISA KEV block are empty for us.
 */
const SECURITY_HEADERS = [
    'Used by', 'Component id', 'Version id', 'Origin id', 'Component name',
    'Component version name', 'Component origin name', 'Component origin id',
    'Component origin version name', 'Vulnerability id', 'Description', 'Published on',
    'Updated on', 'Base score', 'Exploitability', 'Impact', 'Vulnerability source',
    'Remediation status', 'Status justification', 'Remediation target date',
    'Remediation actual date', 'Remediation comment', 'URL', 'Security Risk', 'Project path',
    'Overall score', 'CWE Ids', 'Solution available', 'Workaround available', 'Exploit available',
    'CVSS Version', 'Match type', 'Reachable', 'Vulnerability tags', 'CISA Vulnerability ID',
    'CISA Exploit Added', 'CISA Due Date', 'CISA Required Action', 'CISA Vulnerability Name',
] as const

/** Black Duck's constant for every component in a dependency scan; nothing here varies it. */
const USAGE = 'DYNAMICALLY_LINKED'

// ---------------------------------------------------------------------------
// Shared cell derivations
// ---------------------------------------------------------------------------

interface SeverityCounts {
    critical: number
    high: number
    medium: number
    low: number
    /** A finding whose severity is none of the four; it stays out of every count column. */
    unknown: number
}

/**
 * Black Duck exports the four per-severity counts and nothing else; `Total` and `Critical and
 * High` are their sums, which is how `transformBlackDuckReports` derives them. The same rule here,
 * so a finding with no recognised severity is counted in neither — it is still in `security.csv`,
 * `_vulnerability_details.csv` and the findings sidecar.
 */
function severityCounts(vulnerabilities: Vulnerability[]): SeverityCounts {
    const counts = {critical: 0, high: 0, medium: 0, low: 0, unknown: 0}
    for (const it of vulnerabilities) {
        switch (it.severity?.toUpperCase()) {
            case 'CRITICAL': counts.critical++; break
            case 'HIGH': counts.high++; break
            case 'MEDIUM': counts.medium++; break
            case 'LOW': counts.low++; break
            default: counts.unknown++
        }
    }
    return counts
}

/** Per-severity cells blank when zero, the two sums always a number — `columns.ts`'s rule. */
function countCells(counts: SeverityCounts): NamedRow {
    return {
        'Critical Vulnerability Count': countCell(counts.critical),
        'High Vulnerability Count': countCell(counts.high),
        'Medium Vulnerability Count': countCell(counts.medium),
        'Low Vulnerability Count': countCell(counts.low),
        'Total Vulnerability Count': String(counts.critical + counts.high + counts.medium + counts.low),
        'Critical and High Vulnerability Count': String(counts.critical + counts.high),
    }
}

/**
 * Black Duck writes an advisory it holds in two catalogues as `<primary> (<CVE>)` —
 * `BDSA-2025-13701 (CVE-2025-37727)`. We have no BDSA numbers, so the primary id is the GHSA when
 * a source knew one, and the parenthesised CVE follows it. A finding known by only one id is
 * written as that id alone, exactly as Black Duck writes its NVD-only rows.
 */
function vulnerabilityId(vulnerability: Vulnerability): string {
    const ids = (vulnerability.identifiers ?? []).map(it => it.value)
    const cve = ids.find(it => it.toUpperCase().startsWith('CVE-'))
    const primary = ids.find(it => it.toUpperCase().startsWith('GHSA-')) ?? ids[0] ?? ''
    if (!cve || cve === primary) return primary
    return `${primary} (${cve})`
}

/**
 * Which catalogue the finding came from, in Black Duck's `Vulnerability source` vocabulary.
 * A finding two sources agree on carries both names in `source`; the column takes one value, so
 * the advisory database wins over a scanner — it is the one that names the advisory.
 */
function vulnerabilitySource(vulnerability: Vulnerability): string {
    const sources = (vulnerability.source ?? '').split(',').map(it => it.trim()).filter(Boolean)
    if (sources.includes('github')) return 'GHSA'
    if (sources.includes('trivy')) return 'TRIVY'
    if (sources.includes('grype')) return 'GRYPE'
    return sources[0]?.toUpperCase() ?? ''
}

/**
 * `CVSS 3.x` / `CVSS 4` / `CVSS 2.x`, read off the vector's own prefix rather than the score.
 * The first two spellings are Black Duck's, taken from the reference export; no CVSS 2 row occurs
 * there, so `CVSS 2.x` follows the v3 spelling.
 */
function cvssVersion(vulnerability: Vulnerability): string {
    const vector = vulnerability.cvssVector ?? ''
    if (vector.startsWith('CVSS:4')) return 'CVSS 4'
    if (vector.startsWith('CVSS:3')) return 'CVSS 3.x'
    // A CVSS 2 vector carries no version prefix at all (`AV:N/AC:L/Au:N/C:P/I:P/A:P`).
    if (vector) return 'CVSS 2.x'
    const declared = vulnerability.cvssVersion ?? ''
    if (declared.startsWith('4')) return 'CVSS 4'
    if (declared.startsWith('3')) return 'CVSS 3.x'
    if (declared.startsWith('2')) return 'CVSS 2.x'
    return ''
}

/** Black Duck's list syntax: `[CWE-400, CWE-834]`, and an empty cell rather than `[]`. */
function cweIds(vulnerability: Vulnerability): string {
    const ids = vulnerability.cweIds ?? []
    return ids.length > 0 ? `[${ids.join(', ')}]` : ''
}

function isoDate(timestamp: number | undefined): string {
    if (timestamp === undefined || !Number.isFinite(timestamp)) return ''
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/**
 * The date shape of Black Duck's raw `security_*.csv`: `7/24/26`, month and day unpadded,
 * two-digit year, UTC. Only `security.csv` uses it; the four shareable files write
 * `\tYYYY-MM-DD`, the shape `transformBlackDuckReports` turns this one into.
 */
export function blackDuckDate(timestamp: number | undefined): string {
    const iso = isoDate(timestamp)
    if (!iso) return ''
    const [year, month, day] = iso.split('-')
    return `${Number(month)}/${Number(day)}/${year.slice(2)}`
}

/**
 * Black Duck links every finding that has a CVE to its NVD page, whatever catalogue it came from.
 * Ours would otherwise be the scanner's own page (`avd.aquasec.com`, `github.com/advisories`),
 * which says the same thing at a different address; only a finding with no CVE keeps that.
 */
export function vulnerabilityUrl(vulnerability: Vulnerability): string {
    const cve = (vulnerability.identifiers ?? []).map(it => it.value).find(it => /^CVE-\d{4}-\d+$/i.test(it))
    if (cve) return `https://nvd.nist.gov/vuln/detail/${cve.toUpperCase()}`
    return vulnerability.permalink ?? ''
}

/**
 * The vulnerability files carry one value, not the three-valued column: Black Duck's own
 * `security_*.csv` only ever says `Direct Dependency` or `Transitive Dependency`, so a component
 * reached both ways is reported here as direct.
 */
function dependencyMatchType(component: ExportComponent): string {
    return component.matchType.startsWith('Direct') ? 'Direct Dependency' : 'Transitive Dependency'
}

// ---------------------------------------------------------------------------
// The five serialisers
// ---------------------------------------------------------------------------

function dependencyRows(model: BlackDuckModel): NamedRow[] {
    return model.components.map(component => {
        const {names, families} = licenseColumns(component.licenses)
        return {
            'Component name': component.name,
            'Component version name': component.version,
            // Black Duck's internal version UUID; nothing on our side corresponds to it.
            'Version id': '',
            'Component Version Origin Id': component.originId,
            'License names': names,
            'License families': families,
            'Match type': normalizeMatchType(component.matchType),
            'Usage': USAGE,
            'Operational Risk': operationalRisk(component.releaseDate, component.newerVersions),
            'Origin name': component.origin.name,
            'License Risk': licenseRisk(component.licenses),
            ...countCells(severityCounts(component.vulnerabilities)),
            'Release Date': isoToTabIso(component.releaseDate),
            'Newer Versions': component.newerVersions,
            'Commit Activity': '',
            'Commits in Past 12 Months': '',
            'Contributors in Past 12 Months': '',
            'Has License Conflicts': 'false',
            'Component Link': componentLink(component.origin, component.name, component.homepageUrl),
            'Open Hub URL': '',
        }
    })
}

function dependencySourceRows(model: BlackDuckModel): NamedRow[] {
    // Paths are keyed on the SBOM's own coordinates; the model on the origin id. A path whose
    // component the analysis never reached (an ecosystem with no sbom-* plugin) is dropped rather
    // than emitted with empty licence and vulnerability cells.
    const byCoordinates = new Map(model.components.map(it => [`${it.purlType}|${it.name}|${it.version}`, it]))
    const rows: NamedRow[] = []
    for (const sbomPath of model.paths) {
        const component = byCoordinates.get(`${sbomPath.purlType}|${sbomPath.name}|${sbomPath.version}`)
        if (!component) continue
        const {names, families} = licenseColumns(component.licenses)
        rows.push({
            'Component name': component.name,
            'Component version name': component.version,
            'Version id': '',
            'Component Version Origin Id': component.originId,
            'Match type': normalizeMatchType(sbomPath.matchType),
            'Path': sbomPath.path,
            'ProjectPath': sbomPath.projectPath,
            // What the transform writes when no --basePath verifies the path on disk; we verify none.
            'VerifiedPath': '',
            'VerifiedPathMethod': 'not-checked',
            'Origin name': component.origin.name,
            'License names': names,
            'License families': families,
            'License Risk': licenseRisk(component.licenses),
            ...countCells(severityCounts(component.vulnerabilities)),
            'Operational Risk': operationalRisk(component.releaseDate, component.newerVersions),
            'Release Date': isoToTabIso(component.releaseDate),
            'Newer Versions': component.newerVersions,
            'OpenHubURL': '',
        })
    }
    return rows
}

/** `_component_versions.csv`: the registry facts behind `Newer Versions`, plus our semver count. */
function componentVersionRows(model: BlackDuckModel): NamedRow[] {
    return model.components.map(component => ({
        'Component name': component.name,
        'Component version name': component.version,
        'Component Version Origin Id': component.originId,
        'Origin name': component.origin.name,
        'Release Date': component.releaseDate,
        'Newer Versions': component.newerVersions,
        'Newer Versions (semver)': component.newerVersionsSemver,
    }))
}

function dependencyEdgeRows(model: BlackDuckModel): NamedRow[] {
    return model.edges.map(edge => ({
        'Repo': edge.repo,
        'Tree': edge.tree,
        'Ecosystem': edge.purlType,
        'Parent Origin Id': edge.parent,
        'Child Origin Id': edge.child,
        'Child Depth': String(edge.depth),
    }))
}

export function upgradeGuidanceRows(components: ExportComponent[]): NamedRow[] {
    return upgradeGuidance(components).map(({component, shortTerm, longTerm}) => {
        // What the component would still carry at the recommended version: zero for every fixable
        // finding by construction, so the counts are the findings no version fixes.
        const cleared = (version: string | undefined): SeverityCounts => severityCounts(
            version === undefined ? component.vulnerabilities : remainingAt(component, version))
        const short = cleared(shortTerm)
        const long = cleared(longTerm)
        const recommendation = (version: string | undefined, counts: SeverityCounts, prefix: string): NamedRow =>
            version === undefined
                ? {
                    [`${prefix} Recommended Version Name`]: '',
                    [`${prefix} Recommended Origin Name`]: '',
                    [`${prefix} Recommended Origin Id`]: '',
                    [`${prefix} Recommended Origin Version Name`]: '',
                    [`${prefix} Critical Vulnerability`]: '',
                    [`${prefix} High Vulnerability`]: '',
                    [`${prefix} Medium Vulnerability`]: '',
                    [`${prefix} Low Vulnerability`]: '',
                }
                : {
                    [`${prefix} Recommended Version Name`]: version,
                    [`${prefix} Recommended Origin Name`]: component.origin.name,
                    [`${prefix} Recommended Origin Id`]: originId(component.origin, component.name, version),
                    [`${prefix} Recommended Origin Version Name`]: version,
                    [`${prefix} Critical Vulnerability`]: String(counts.critical),
                    [`${prefix} High Vulnerability`]: String(counts.high),
                    [`${prefix} Medium Vulnerability`]: String(counts.medium),
                    [`${prefix} Low Vulnerability`]: String(counts.low),
                }
        return {
            'Component Name': component.name,
            'Component Version Name': component.version,
            'Component Origin Name': component.origin.name,
            'Component Version Origin Id': component.originId,
            'Total Known Vulnerabilities': String(component.vulnerabilities.length),
            ...recommendation(shortTerm, short, 'Short Term'),
            ...recommendation(longTerm, long, 'Long Term'),
        }
    })
}

/** The cells of a `security.csv` row we can fill; `securityRow` adds Black Duck's empties. */
function findingRow(model: BlackDuckModel, {component, vulnerability}: ExportFinding): NamedRow {
    const subScores = cvss3SubScores(vulnerability.cvssVector)
    return {
        'Component name': component.name,
        'Component version name': component.version,
        'Component Version Origin Id': component.originId,
        'Vulnerability id': vulnerabilityId(vulnerability),
        'Description': vulnerability.description || vulnerability.summary || '',
        'Published on': blackDuckDate(vulnerability.timestamp),
        'Updated on': '',
        'Base score': vulnerability.score === undefined ? '' : String(vulnerability.score),
        'Exploitability': subScores?.exploitability === undefined ? '' : String(subScores.exploitability),
        'Impact': subScores?.impact === undefined ? '' : String(subScores.impact),
        'Vulnerability source': vulnerabilitySource(vulnerability),
        // No triage state exists on our side, so every finding is new — Black Duck's own default.
        'Remediation status': 'New',
        'URL': vulnerabilityUrl(vulnerability),
        'Security Risk': (vulnerability.severity ?? '').toUpperCase(),
        'Project path': model.projectName,
        'Overall score': '',
        'CWE Ids': cweIds(vulnerability),
        'Solution available': vulnerability.firstPatchedVersion ? 'true' : 'false',
        'Workaround available': '',
        // CISA KEV is not wired up, so exploit availability is unknown, not false.
        'Exploit available': '',
        'CVSS Version': cvssVersion(vulnerability),
        'Match type': dependencyMatchType(component),
        'Vulnerability tags': '',
    }
}

function securityRow(model: BlackDuckModel, finding: ExportFinding): NamedRow {
    const {component} = finding
    return {
        ...findingRow(model, finding),
        'Component origin name': component.origin.name,
        'Component origin id': component.originId,
        'Component origin version name': component.version,
    }
}

/**
 * A `_vulnerability_details.csv` row: the `security.csv` cells the transform keeps, with its
 * conventions — dates as `\tYYYY-MM-DD`, cells trimmed. `Match type` stays two-valued
 * (`Direct Dependency`) here, as the transform leaves it in this file.
 */
function vulnerabilityDetailRow(model: BlackDuckModel, finding: ExportFinding): NamedRow {
    const row = findingRow(model, finding)
    return {
        ...row,
        'Description': row['Description'].trim(),
        'Published on': isoToTabIso(isoDate(finding.vulnerability.timestamp)),
        'Updated on': '',
    }
}

// ---------------------------------------------------------------------------

export interface WrittenFile {
    file: string
    rows: number
}

function write(resultFolder: string, file: string, headers: readonly string[], rows: NamedRow[]): WrittenFile {
    fs.mkdirSync(resultFolder, {recursive: true})
    fs.writeFileSync(path.resolve(resultFolder, file), csvDocument(headers, rows))
    return {file, rows: rows.length}
}

/** Writes every file into `resultFolder`, in `BLACKDUCK_FILES` order, and reports what went where. */
export function writeBlackDuckExport(model: BlackDuckModel, resultFolder: string): WrittenFile[] {
    const unknown = model.components.reduce((n, it) => n + severityCounts(it.vulnerabilities).unknown, 0)
    if (unknown > 0) {
        log.warn(`${unknown} finding(s) carry no recognised severity and are left out of the vulnerability`
            + ` count columns; they are still in security.csv, ${VULNERABILITY_DETAILS_FILE} and ${VULNERABILITY_FINDINGS_FILE}`)
    }
    return [
        write(resultFolder, DEPENDENCIES_FILE, DEPENDENCIES_COLUMNS, dependencyRows(model)),
        write(resultFolder, DEPENDENCIES_SOURCES_FILE, DEPENDENCIES_SOURCES_COLUMNS, dependencySourceRows(model)),
        write(resultFolder, DEPENDENCY_EDGES_FILE, DEPENDENCY_EDGES_HEADERS, dependencyEdgeRows(model)),
        write(resultFolder, COMPONENT_VERSIONS_FILE, COMPONENT_VERSIONS_COLUMNS, componentVersionRows(model)),
        writeUpgradeGuidanceCsv(model.components, resultFolder),
        writeSecurityCsv(model, resultFolder),
        write(resultFolder, VULNERABILITY_DETAILS_FILE, VULNERABILITY_DETAILS_COLUMNS,
            model.findings.map(it => vulnerabilityDetailRow(model, it))),
        writeVulnerabilityFindings(model, resultFolder),
    ]
}

/** Just `_upgrade_guidance.csv`, from any component list. */
export function writeUpgradeGuidanceCsv(components: ExportComponent[], resultFolder: string): WrittenFile {
    return write(resultFolder, UPGRADE_GUIDANCE_FILE, UPGRADE_GUIDANCE_COLUMNS, upgradeGuidanceRows(components))
}

/**
 * `_vulnerability_findings.json`: every finding the scanners reported, per component, as the
 * exporter saw it — including the fields no CSV carries (`patchedVersions`, the fix per line).
 *
 * The scanners run inside `export-blackduck` and their answer lives nowhere else: the saved SBOM
 * has no vulnerabilities and `security.csv` names no fixed version. So a change to the upgrade
 * guidance rule could only be seen by re-running the scanners, which puts today's databases under
 * a run made against yesterday's — no longer the run that was compared with Black Duck. This file
 * is the sidecar that would let a later recompute re-derive
 * `_upgrade_guidance.csv` from the findings of the day, the way `_graph_rebuild.json` lets the
 * graph be rebuilt. It carries what `upgradeGuidanceRows` reads and nothing else; the registry
 * version list comes from the registry cache at recompute time.
 */
export interface VulnerabilityFindingsFile {
    schema: 1
    components: VulnerableComponent[]
}

export type VulnerableComponent = Pick<ExportComponent, 'name' | 'version' | 'purlType' | 'origin' | 'originId' | 'vulnerabilities'>

export function vulnerabilityFindings(model: BlackDuckModel): VulnerabilityFindingsFile {
    return {
        schema: 1,
        components: model.components
            .filter(it => it.vulnerabilities.length > 0)
            .map(({name, version, purlType, origin, originId, vulnerabilities}) =>
                ({name, version, purlType, origin, originId, vulnerabilities})),
    }
}

export function writeVulnerabilityFindings(model: BlackDuckModel, resultFolder: string): WrittenFile {
    const findings = vulnerabilityFindings(model)
    fs.mkdirSync(resultFolder, {recursive: true})
    fs.writeFileSync(path.resolve(resultFolder, VULNERABILITY_FINDINGS_FILE), JSON.stringify(findings, null, 2))
    return {file: VULNERABILITY_FINDINGS_FILE, rows: findings.components.length}
}

/**
 * Just `security.csv`. `analyse` writes this one file for every run, SBOM or not — it is the only
 * place the CVSS vector, CWE ids, fixed version and publication date behind the two libs.csv
 * vulnerability columns survive — and calls the same serialiser `export-blackduck` does, so the
 * two commands cannot drift into two spellings of the same header.
 */
export function writeSecurityCsv(model: BlackDuckModel, resultFolder: string): WrittenFile {
    return write(resultFolder, SECURITY_FILE, SECURITY_HEADERS, model.findings.map(it => securityRow(model, it)))
}

export const BLACKDUCK_FILES = [
    DEPENDENCIES_FILE,
    DEPENDENCIES_SOURCES_FILE,
    DEPENDENCY_EDGES_FILE,
    COMPONENT_VERSIONS_FILE,
    UPGRADE_GUIDANCE_FILE,
    SECURITY_FILE,
    VULNERABILITY_DETAILS_FILE,
    VULNERABILITY_FINDINGS_FILE,
] as const
