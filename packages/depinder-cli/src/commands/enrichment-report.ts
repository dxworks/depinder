import fs from 'fs'
import path from 'path'
import {DepinderDependency} from '../extension-points/extract'
import {csvDocument} from '../utils/csv'

type UnresolvedStatus = 'lookup_failed' | 'cached_miss'
type EnrichmentStatus = 'resolved' | 'skipped' | UnresolvedStatus

export type EnrichmentOutcome =
    | {status: 'resolved' | 'skipped'}
    | {status: UnresolvedStatus, reason: string}

export interface EnrichmentProject {
    name: string
    version: string
    path: string
    /** Absolute path of the SBOM the project was parsed from: tells same-named lockfiles apart. */
    sbomFile: string
}

export interface PackageCounts {
    detected: number
    resolved: number
    unresolved: number
    skipped: number
}

export interface EnrichmentSummary {
    schemaVersion: 1
    source: string
    countingUnit: 'ecosystem+name+version'
    scope: 'dependencies parsed by selected plugins'
    totals: PackageCounts
    ecosystems: Record<string, PackageCounts>
}

export interface UnresolvedPackage {
    ecosystem: string
    name: string
    version: string
    purl: string
    projects: EnrichmentProject[]
    status: UnresolvedStatus
    reason: string
}

interface PackageEntry {
    ecosystem: string
    name: string
    version: string
    purl: string
    projects: Map<string, EnrichmentProject>
    outcomes: Set<EnrichmentStatus>
    reasons: Map<UnresolvedStatus, Set<string>>
}

function emptyCounts(): PackageCounts {
    return {detected: 0, resolved: 0, unresolved: 0, skipped: 0}
}

function sortedValues<T>(entries: Map<string, T>): T[] {
    return [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => value)
}

/** Success on any occurrence wins; a cached miss must not hide a failure observed this run. */
function finalStatus(entry: PackageEntry): EnrichmentStatus {
    for (const status of ['resolved', 'lookup_failed', 'cached_miss'] as const) {
        if (entry.outcomes.has(status)) return status
    }
    return 'skipped'
}

/** One source's package identities and explicit metadata lookup outcomes, never inferred from SBOM fields. */
export class EnrichmentReport {
    private readonly packages = new Map<string, PackageEntry>()

    observe(
        ecosystem: string,
        project: EnrichmentProject,
        dependency: Pick<DepinderDependency, 'name' | 'version' | 'purl'>,
        outcome: EnrichmentOutcome,
    ): void {
        const key = JSON.stringify([ecosystem, dependency.name, dependency.version])
        let entry = this.packages.get(key)
        if (!entry) {
            entry = {
                ecosystem, name: dependency.name, version: dependency.version, purl: '',
                projects: new Map(), outcomes: new Set(), reasons: new Map(),
            }
            this.packages.set(key, entry)
        }
        if (dependency.purl && (!entry.purl || dependency.purl < entry.purl)) entry.purl = dependency.purl
        const reference = {name: project.name, version: project.version, path: project.path, sbomFile: project.sbomFile}
        entry.projects.set(JSON.stringify([reference.sbomFile, reference.name, reference.version, reference.path]), reference)
        entry.outcomes.add(outcome.status)
        if (outcome.status === 'lookup_failed' || outcome.status === 'cached_miss') {
            const reasons = entry.reasons.get(outcome.status) ?? new Set<string>()
            reasons.add(outcome.reason)
            entry.reasons.set(outcome.status, reasons)
        }
    }

    snapshot(source: string): {summary: EnrichmentSummary, unresolved: UnresolvedPackage[]} {
        const summary: EnrichmentSummary = {
            schemaVersion: 1,
            source,
            countingUnit: 'ecosystem+name+version',
            scope: 'dependencies parsed by selected plugins',
            totals: emptyCounts(),
            ecosystems: {},
        }
        const unresolved: UnresolvedPackage[] = []
        for (const entry of sortedValues(this.packages)) {
            const status = finalStatus(entry)
            const category = status === 'lookup_failed' || status === 'cached_miss' ? 'unresolved' : status
            const ecosystemCounts = summary.ecosystems[entry.ecosystem] ?? emptyCounts()
            summary.ecosystems[entry.ecosystem] = ecosystemCounts
            summary.totals.detected++
            summary.totals[category]++
            ecosystemCounts.detected++
            ecosystemCounts[category]++
            if (status === 'lookup_failed' || status === 'cached_miss') {
                unresolved.push({
                    ecosystem: entry.ecosystem, name: entry.name, version: entry.version, purl: entry.purl,
                    projects: sortedValues(entry.projects),
                    status,
                    reason: [...entry.reasons.get(status) ?? []].sort().join('\n'),
                })
            }
        }
        return {summary, unresolved}
    }
}

const UNRESOLVED_HEADERS = ['ecosystem', 'name', 'version', 'purl', 'projects', 'status', 'reason'] as const

export function writeEnrichmentReport(resultFolder: string, report: EnrichmentReport): EnrichmentSummary {
    const {summary, unresolved} = report.snapshot(path.basename(resultFolder))
    fs.mkdirSync(resultFolder, {recursive: true})
    fs.writeFileSync(path.join(resultFolder, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
    fs.writeFileSync(path.join(resultFolder, 'unresolved-packages.csv'), csvDocument(UNRESOLVED_HEADERS,
        unresolved.map(item => ({...item, projects: JSON.stringify(item.projects)}))))
    return summary
}
