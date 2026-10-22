import _ from 'lodash'
import moment from 'moment'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {availableVersions, LibraryInfo, usedVersionTimestamp} from '../extension-points/library-info'
import {licenseIdentity} from '../blackduck/licenses'
import {csvRow} from '../utils/csv'
import {reportNow} from '../utils/report-clock'

function extractLicenses(dep: DepinderDependency) {
    // Older cache entries can hold null licenses; skip them.
    return dep.libraryInfo?.licenses?.filter(it => it != null).map(it => {
        if (typeof it === 'string') return it.substring(0, 100); else return JSON.stringify(it)
    })
}

/**
 * The release moment of a version, or `undefined` when there is none: the version is not in the
 * registry's list, or the registry has no date for it (`NaN`). `moment(undefined)` is *now* and
 * `moment(NaN)` formats as "Invalid date", so every date column goes through here and a missing
 * date becomes a blank cell rather than this month or a string nobody can sort on.
 */
function releaseMoment(timestamp: number | undefined): moment.Moment | undefined {
    return timestamp !== undefined && Number.isFinite(timestamp) ? moment(timestamp) : undefined
}

/** Whole months from `earlier` to `later`; `undefined` (a blank cell) when either date is missing. */
function monthsBetween(later: moment.Moment | undefined, earlier: moment.Moment | undefined): number | undefined {
    return later && earlier ? later.diff(earlier, 'months') : undefined
}

/** The `Type` column of libs.csv stays blank: neither Syft nor Trivy records a dependency scope. */
const NO_DEPENDENCY_SCOPE = ''

function convertDepToRow(proj: DepinderProject, dep: DepinderDependency): string {
    const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
    const latestVersionMoment = releaseMoment(latestVersion?.timestamp)
    const currentVersionMoment = releaseMoment(usedVersionTimestamp(dep.libraryInfo?.versions, dep.version))
    const now = moment(reportNow())

    const dateFormat = 'MMM YYYY'
    const vulnerabilities = dep.vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n')
    const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))
    return csvRow([
        proj.path, proj.name, dep.name, dep.version, latestVersion?.version,
        currentVersionMoment?.format(dateFormat), latestVersionMoment?.format(dateFormat),
        monthsBetween(latestVersionMoment, currentVersionMoment),
        monthsBetween(now, currentVersionMoment), monthsBetween(now, latestVersionMoment),
        dep.vulnerabilities?.length, vulnerabilities, directDep, NO_DEPENDENCY_SCOPE, extractLicenses(dep),
    ])
}

/**
 * The license a library is grouped under. Library-level `licenses` is the field every registry
 * fills (and the one libs.csv reports); the per-version list is optional and left empty by some
 * (maven sets `licenses: []` on every version), so it is only the fallback, for registries that
 * fill nothing else.
 * It is read the same way as the Black Duck licence columns, so both outputs agree.
 */
function licenseOf(lib: LibraryInfo): string {
    const license = lib.licenses?.find(it => typeof it === 'string' && it)
        ?? availableVersions(lib.versions).flatMap(it => it.licenses).find(it => typeof it === 'string' && it)
    return license ? licenseIdentity(license) : 'unknown'
}

interface DependencyInfo extends DepinderDependency {
    direct: boolean
    latest_used: number
    now_used: number
    now_latest: number
}

function licensesReport(projects: DepinderProject[]): string {
    const allLibsInfo = projects.flatMap(proj => Object.values(proj.dependencies).map(dep => dep.libraryInfo))
        .filter(it => it !== undefined && it != null).map(it => it as LibraryInfo)
    const allLicenses = _.groupBy(allLibsInfo, licenseOf)
    const licensesHeader = 'License,Libraries,Library Names\n'
    return licensesHeader + Object.keys(allLicenses).map(license =>
        csvRow([license, allLicenses[license].length, allLicenses[license].map(it => it.name).join(', ')])
    ).join('\n')
}

function libsReport(projects: DepinderProject[]): string {
    const header = 'Project Path,Project,Library,Used Version,Latest Version,Used Version Release Date,Latest Version Release Date,Latest-Used,Now-Used,Now-latest,Vulnerabilities,Vulnerability Details,DirectDependency,Type,Licenses\n'
    return header + projects.flatMap(proj =>
        Object.values(proj.dependencies).map(dep => convertDepToRow(proj, dep))).join('\n')
}

function projectStatsReport(projects: DepinderProject[]): string {
    const projectStatsHeader = 'Project Path,Project,Direct Deps,Indirect Deps,Direct Outdated Deps, Direct Outdated %,Indirect Outdated Deps, Indirect Outdated %, Direct Vulnerable Deps, Indirect Vulnerable Deps, Direct Out of Support, Indirect Out of Support\n'
    return projectStatsHeader + projects.map(proj => {
        const enhancedDeps: DependencyInfo[] = Object.values(proj.dependencies).map(dep => {
            const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
            const latestVersionMoment = releaseMoment(latestVersion?.timestamp)
            const currentVersionMoment = releaseMoment(usedVersionTimestamp(dep.libraryInfo?.versions, dep.version))
            const now = moment(reportNow())
            const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))

            // A missing date is NaN here, which no threshold below counts as outdated or out
            // of support.
            return {
                ...dep,
                direct: directDep,
                latest_used: monthsBetween(latestVersionMoment, currentVersionMoment) ?? NaN,
                now_used: monthsBetween(now, currentVersionMoment) ?? NaN,
                now_latest: monthsBetween(now, latestVersionMoment) ?? NaN,
            } as DependencyInfo
        })
        const directDeps = enhancedDeps.filter(dep => dep.direct)
        const indirectDeps = enhancedDeps.filter(dep => !dep.direct)

        const outdatedThreshold = 15

        const directOutdated = directDeps.filter(dep => dep.latest_used > outdatedThreshold)
        const directOutDatedPercent = directDeps.length == 0 ? 0 : directOutdated.length / directDeps.length * 100
        const indirectOutdated = indirectDeps.filter(dep => dep.latest_used > outdatedThreshold)
        const indirectOutDatedPercent = indirectDeps.length == 0 ? 0 : indirectOutdated.length / indirectDeps.length * 100
        const directVulnerable = directDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0)
        const indirectVulnerable = indirectDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0)

        const outOfSupportThreshold = 24
        const directOutOfSupport = directDeps.filter(dep => dep.now_latest > outOfSupportThreshold)
        const indirectOutOfSupport = indirectDeps.filter(dep => dep.now_latest > outOfSupportThreshold)

        return csvRow([
            proj.path, proj.name, directDeps.length, indirectDeps.length,
            directOutdated.length, directOutDatedPercent, indirectOutdated.length,
            indirectOutDatedPercent, directVulnerable.length, indirectVulnerable.length,
            directOutOfSupport.length, indirectOutOfSupport.length,
        ])
    }).join('\n')
}

/**
 * The three CSV reports one plugin's enriched projects produce, keyed by report name: the caller
 * writes each document to `<plugin>-<key>.csv` in the results folder.
 */
export function analysisCsvReports(projects: DepinderProject[]): Record<'licenses' | 'libs' | 'project-stats', string> {
    return {
        licenses: licensesReport(projects),
        libs: libsReport(projects),
        'project-stats': projectStatsReport(projects),
    }
}
