import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {ecosystemForPurlType} from '../vuln-sources/github/ecosystems'
import {comparatorFor, VersionComparator} from '../vuln-sources/github/versions'
import {Origin, originFor, originId} from './origins'
import {SbomPath} from './paths'

/**
 * The one in-memory model every Black Duck-shaped CSV is written from.
 *
 * The five exports are five views of the same three facts — a component, where it sits in the
 * graph, and what is wrong with it — so they are assembled once here and serialised five times in
 * `write.ts`. Nothing in this file knows about CSV, and nothing in `write.ts` knows about
 * depinder's dependency model; that split is what keeps the column definitions readable next to
 * the real export they copy.
 *
 * The key throughout is the `Component Version Origin Id`, because that is the only column Black
 * Duck and depinder can be joined on: Black Duck's `Component name` is a Knowledge Base display
 * name (`Action Mailer` for the gem `actionmailer`) and never matches a registry name.
 */

export type MatchType = 'Direct' | 'Transitive' | 'Direct,Transitive'

export interface ExportComponent {
    name: string
    version: string
    purlType: string
    origin: Origin
    originId: string
    matchType: MatchType
    /** SPDX ids as the registrar reported them; `licenses.ts` turns them into BD's two columns. */
    licenses: string[]
    /** ISO `YYYY-MM-DD`, from the registry's timestamp for this exact version. */
    releaseDate: string
    /** Registry versions ordered above this one. Empty when no registrar answered. */
    newerVersions: string
    homepageUrl?: string
    vulnerabilities: Vulnerability[]
    /** Every version the registrar knows, ordered — the input to upgrade guidance. */
    registryVersions: string[]
    /** This ecosystem's version ordering, so upgrade guidance need not rediscover it. */
    compare: VersionComparator
}

/**
 * The version ordering for a purl type. `versions.ts` in the GitHub source already owns one
 * comparator per ecosystem family, correct for pre-releases and for the shapes registries emit;
 * reusing it means "newer than" means the same thing in the export as it does in the matcher.
 */
export function comparatorForPurlType(purlType: string): VersionComparator {
    return comparatorFor(ecosystemForPurlType(purlType)?.comparator ?? 'generic')
}

export interface ExportFinding {
    component: ExportComponent
    vulnerability: Vulnerability
}

export interface BlackDuckModel {
    /** The name Black Duck would call the project version; ours is the export's root label. */
    projectName: string
    components: ExportComponent[]
    findings: ExportFinding[]
    paths: SbomPath[]
}

/** One plugin's contribution to the model: the purl type it filtered on and what it enriched. */
export interface AnalysedEcosystem {
    purlType: string
    projects: DepinderProject[]
}

/**
 * Direct or transitive, by the same rule `<plugin>-libs.csv` uses, but three-valued as Black Duck
 * reports it: a component reached both straight from the project and through another dependency
 * is `Direct,Transitive`.
 */
function matchTypesOf(project: DepinderProject, dependency: DepinderDependency): Set<'Direct' | 'Transitive'> {
    const projectId = `${project.name}@${project.version}`
    const requestedBy = dependency.requestedBy ?? []
    if (requestedBy.length === 0) return new Set(['Direct'])
    const types = new Set<'Direct' | 'Transitive'>()
    for (const requester of requestedBy) {
        types.add(requester.startsWith(projectId) ? 'Direct' : 'Transitive')
    }
    return types
}

function renderMatchType(types: Set<'Direct' | 'Transitive'>): MatchType {
    if (types.has('Direct') && types.has('Transitive')) return 'Direct,Transitive'
    return types.has('Direct') ? 'Direct' : 'Transitive'
}

function isoDate(timestamp: number | undefined): string {
    if (timestamp === undefined || !Number.isFinite(timestamp)) return ''
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/**
 * Two findings are the same finding when they share any identifier — the rule `merge.ts` already
 * applies across sources, restated here because the same component can be enriched by more than
 * one project and the export must not report an advisory twice.
 */
function sameFinding(a: Vulnerability, b: Vulnerability): boolean {
    const left = new Set((a.identifiers ?? []).map(it => it.value.toUpperCase()))
    return (b.identifiers ?? []).some(it => left.has(it.value.toUpperCase()))
}

export function buildModel(
    projectName: string,
    ecosystems: AnalysedEcosystem[],
    paths: SbomPath[]
): BlackDuckModel {
    const components = new Map<string, ExportComponent>()
    const matchTypes = new Map<string, Set<'Direct' | 'Transitive'>>()

    for (const {purlType, projects} of ecosystems) {
        for (const project of projects) {
            for (const dependency of Object.values(project.dependencies)) {
                const origin = originFor(purlType, dependency.name)
                const id = originId(origin, dependency.name, dependency.version)

                const seen = matchTypes.get(id) ?? new Set<'Direct' | 'Transitive'>()
                for (const type of matchTypesOf(project, dependency)) seen.add(type)
                matchTypes.set(id, seen)

                const existing = components.get(id)
                if (existing) {
                    for (const finding of dependency.vulnerabilities ?? []) {
                        if (!existing.vulnerabilities.some(it => sameFinding(it, finding))) {
                            existing.vulnerabilities.push(finding)
                        }
                    }
                    continue
                }
                components.set(id, toComponent(origin, purlType, id, dependency))
            }
        }
    }

    for (const [id, types] of matchTypes) {
        const component = components.get(id)
        if (component) component.matchType = renderMatchType(types)
    }

    const ordered = [...components.values()].sort((a, b) => a.originId.localeCompare(b.originId))
    const findings = ordered.flatMap(component =>
        component.vulnerabilities.map(vulnerability => ({component, vulnerability})))

    return {projectName, components: ordered, findings, paths}
}

function toComponent(origin: Origin, purlType: string, id: string, dependency: DepinderDependency): ExportComponent {
    const library = dependency.libraryInfo
    const versions = library?.versions ?? []
    const current = versions.find(it => it.version === dependency.version.trim())
    const compare = comparatorForPurlType(purlType)

    // Library-level `licenses` is the field every registrar fills; the per-version list is
    // optional and left empty by some, so it is the fallback rather than the source.
    const licenses = (library?.licenses ?? []).filter((it): it is string => typeof it === 'string' && !!it)
    const versionLicenses = ([] as (string | string[] | undefined)[])
        .concat(current?.licenses)
        .flatMap(it => (Array.isArray(it) ? it : [it]))
        .filter((it): it is string => typeof it === 'string' && !!it)

    return {
        name: dependency.name,
        version: dependency.version,
        purlType,
        origin,
        originId: id,
        matchType: 'Transitive',
        licenses: licenses.length > 0 ? licenses : versionLicenses,
        releaseDate: isoDate(current?.timestamp),
        // Empty rather than 0 when no registrar answered: "we do not know" and "you are current"
        // are different statements, and Black Duck's column distinguishes them too.
        newerVersions: versions.length === 0
            ? ''
            : String(versions.filter(it => compare(it.version, dependency.version) > 0).length),
        homepageUrl: library?.homepageUrl || undefined,
        vulnerabilities: [...(dependency.vulnerabilities ?? [])],
        registryVersions: versions.map(it => it.version).sort(compare),
        compare,
    }
}
