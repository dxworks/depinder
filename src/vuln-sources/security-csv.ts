import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {Vulnerability} from '../extension-points/vulnerability-checker'

/**
 * `sbom-security.csv` — one row per (component, advisory, project), in Black Duck's column shape.
 *
 * Why this file exists alongside the `Vulnerabilities` / `Vulnerability Details` columns in
 * `<plugin>-libs.csv`: those two columns are a count and a newline-joined summary, which is all a
 * dependency-level report needs but throws away the CVSS vector, the CWE ids, the fixed version
 * and the publication date. Black Duck's security export keeps all of them, one row per finding,
 * and the people comparing the two want the same shape on both sides.
 *
 * One writer for every source. Whichever of Trivy, Grype or GitHub produced a finding, it arrives
 * as the same `Vulnerability`, so nothing here knows or cares which one ran — the `Vulnerability
 * source` column is simply the `source` field the producer set.
 */

export const SECURITY_CSV_FILE = 'sbom-security.csv'

export const SECURITY_CSV_HEADERS = [
    'Component name',
    'Component version name',
    'Component Version Origin Id',
    'Origin name',
    'Vulnerability id',
    'CVE ids',
    'Vulnerability source',
    'Published on',
    'Base score',
    'CVSS Version',
    'CVSS vector',
    'Security Risk',
    'CWE Ids',
    'Solution available',
    'Fixed version',
    'Match type',
    'Project path',
] as const

export interface SecurityRow {
    [column: string]: string
}

/**
 * Black Duck writes severity as a capitalised band (`High`), depinder's sources as an uppercase
 * one (`HIGH`). The CSV follows Black Duck, since the whole point of the file is to sit next to
 * one of its exports.
 */
function securityRisk(severity: string | undefined): string {
    if (!severity) return ''
    const upper = severity.toUpperCase()
    return upper.charAt(0) + upper.slice(1).toLowerCase()
}

/** The identifier a reader will recognise the finding by: the source's own primary id. */
function vulnerabilityId(vulnerability: Vulnerability): string {
    return vulnerability.identifiers?.[0]?.value ?? ''
}

function cveIds(vulnerability: Vulnerability): string {
    return (vulnerability.identifiers ?? [])
        .filter(it => it.value.toUpperCase().startsWith('CVE-'))
        .map(it => it.value)
        .join(';')
}

/**
 * Direct or transitive, by the same rule `<plugin>-libs.csv` uses for its `DirectDependency`
 * column, so the two files cannot disagree about the same dependency.
 */
function matchType(project: DepinderProject, dependency: DepinderDependency): string {
    const direct = !dependency.requestedBy
        || dependency.requestedBy.some(it => it.startsWith(`${project.name}@${project.version}`))
    return direct ? 'Direct' : 'Transitive'
}

export function securityRowsFor(
    project: DepinderProject,
    dependency: DepinderDependency,
    originName: string
): SecurityRow[] {
    return (dependency.vulnerabilities ?? []).map(vulnerability => ({
        'Component name': dependency.name,
        'Component version name': dependency.version,
        'Component Version Origin Id': `${dependency.name}/${dependency.version}`,
        'Origin name': originName,
        'Vulnerability id': vulnerabilityId(vulnerability),
        'CVE ids': cveIds(vulnerability),
        'Vulnerability source': vulnerability.source ?? '',
        'Published on': vulnerability.timestamp ? new Date(vulnerability.timestamp).toISOString() : '',
        'Base score': vulnerability.score === undefined ? '' : String(vulnerability.score),
        'CVSS Version': vulnerability.cvssVersion ?? '',
        'CVSS vector': vulnerability.cvssVector ?? '',
        'Security Risk': securityRisk(vulnerability.severity),
        'CWE Ids': (vulnerability.cweIds ?? []).join(';'),
        // Black Duck's own definition: a fix exists and is named.
        'Solution available': vulnerability.firstPatchedVersion ? 'true' : 'false',
        'Fixed version': vulnerability.firstPatchedVersion ?? '',
        'Match type': matchType(project, dependency),
        'Project path': project.path,
    }))
}

/** Every row a plugin's projects contribute. `originName` is the plugin's purl type. */
export function securityRowsForProjects(projects: DepinderProject[], originName: string): SecurityRow[] {
    return projects.flatMap(project =>
        Object.values(project.dependencies).flatMap(dependency =>
            securityRowsFor(project, dependency, originName)))
}
