import fs from 'fs'
import path from 'path'
import {SemVer} from 'semver'
import {DepinderDependency, DepinderProject} from '../../extension-points/extract'
import {log} from '../../utils/logging'

/**
 * Parses CycloneDX SBOMs produced offline by Syft and Trivy into DepinderProjects.
 *
 * Both tools emit CycloneDX JSON, which is why it is the chosen interchange format: one parser
 * serves both, so comparing the two tools measures the tools and not our parsing of them.
 *
 * The two differ in one structural way that matters here:
 *  - Trivy emits a three-level graph: root -> one `application` node per manifest -> dependencies.
 *    Those intermediate nodes are the projects, already named by their manifest's relative path.
 *  - Syft emits a two-level graph with no project anchor at all; its root is a `file` node that
 *    does not appear in the dependency graph. A Syft SBOM therefore maps to a single project.
 *
 * In both tools `dependencies[].ref` and `dependsOn[]` are the target's `bom-ref` verbatim, so refs
 * resolve by plain string lookup. Syft's bom-ref happens to look like a purl with a `package-id`
 * qualifier, but that qualifier is part of the identity and must not be stripped.
 */

export interface CycloneDxComponent {
    'bom-ref': string
    type?: string
    group?: string
    name?: string
    version?: string
    purl?: string
    /**
     * CycloneDX allows three shapes here, and real Syft output uses all of them:
     *   { license: { id: 'MIT' } }                                  — an SPDX id
     *   { license: { name: 'The Apache ... 2.0', url: '...' } }      — a non-SPDX name
     *   { expression: 'BSD-3-Clause OR MIT' }                       — a compound SPDX expression
     */
    licenses?: { license?: { id?: string, name?: string }, expression?: string }[]
    properties?: { name: string, value: string }[]
}

export interface CycloneDxBom {
    metadata?: { component?: CycloneDxComponent }
    components?: CycloneDxComponent[]
    dependencies?: { ref: string, dependsOn?: string[] }[]
}

/** A parsed purl, reduced to what depinder's model needs. */
export interface ParsedPurl {
    type: string  // maven, npm, gem, pypi, nuget, composer, ...
    name: string  // normalised to the name the matching registrar expects
    version: string
}

/**
 * Parses a Package URL into the (type, name, version) triple depinder needs.
 *
 * The name must match what the ecosystem's registrar expects or lookups silently return nothing:
 *  - maven wants `groupId:artifactId` (MavenCentralRegistrar splits on ':')
 *  - npm wants the scope preserved as `@scope/name`
 *  - everything else uses the bare name
 *
 * Returns undefined for anything unparseable rather than guessing.
 */
export function parsePurl(purl: string): ParsedPurl | undefined {
    if (!purl?.startsWith('pkg:')) return undefined

    // Strip qualifiers (?a=b) and subpath (#...) — neither contributes to identity here.
    const withoutQualifiers = purl.slice('pkg:'.length).split('?')[0].split('#')[0]

    const slash = withoutQualifiers.indexOf('/')
    if (slash < 0) return undefined

    const type = withoutQualifiers.slice(0, slash).toLowerCase()
    const rest = withoutQualifiers.slice(slash + 1)

    // The version is after the LAST '@' — but npm scoped names start with '@', so a leading '@'
    // must not be mistaken for a version separator.
    const at = rest.lastIndexOf('@')
    if (at <= 0) return undefined

    const namePart = decodeURIComponent(rest.slice(0, at))
    const version = decodeURIComponent(rest.slice(at + 1))
    if (!namePart || !version) return undefined

    let name: string
    if (type === 'maven') {
        // pkg:maven/<groupId>/<artifactId> -> groupId:artifactId
        const lastSlash = namePart.lastIndexOf('/')
        if (lastSlash < 0) return undefined
        name = `${namePart.slice(0, lastSlash)}:${namePart.slice(lastSlash + 1)}`
    } else {
        // npm scoped names arrive as '%40scope/name' and decode to '@scope/name' — keep as-is.
        name = namePart
    }

    return {type, name, version}
}

function firstLicense(component: CycloneDxComponent): string | undefined {
    for (const entry of component.licenses ?? []) {
        // `expression` holds compound SPDX expressions ('BSD-3-Clause OR MIT') and is a sibling of
        // `license`, not a field inside it — reading only `license` silently drops those.
        const value = entry?.license?.id ?? entry?.license?.name ?? entry?.expression
        if (value) return value
    }
    return undefined
}

function toSemVer(version: string): SemVer | null {
    try {
        return new SemVer(version, {loose: true})
    } catch {
        // Snapshot builds, 'UNKNOWN', calendar versions and similar are common and expected.
        return null
    }
}

/** The subset of a project we can derive before walking dependencies. */
interface ProjectNode {
    ref: string
    name: string
    version: string
    path: string
    /**
     * True for the Syft shape, where the root is a `file` node that carries no dependsOn edges.
     * Reachability from it yields nothing, so the project's scope is every component in the BOM.
     */
    allComponents: boolean
}

/**
 * Identifies the project nodes in a BOM.
 *
 * Trivy: the root's direct children of type `application` (one per manifest file).
 * Syft:  no project nodes exist, so the whole BOM is one project named after the scan root.
 */
function findProjectNodes(bom: CycloneDxBom, byRef: Map<string, CycloneDxComponent>, sbomFile: string): ProjectNode[] {
    const rootRef = bom.metadata?.component?.['bom-ref']
    const rootChildren = rootRef
        ? bom.dependencies?.find(d => d.ref === rootRef)?.dependsOn ?? []
        : []

    const applicationChildren = rootChildren
        .map(ref => byRef.get(ref))
        .filter((c): c is CycloneDxComponent => !!c && c.type === 'application' && !c.purl)

    if (applicationChildren.length > 0) {
        return applicationChildren.map(c => {
            const manifestPath = c.name ?? 'unknown'
            return {
                ref: c['bom-ref'],
                // 'neo4j/pom.xml' -> 'neo4j'; a top-level 'pom.xml' -> the SBOM's own basename.
                name: path.dirname(manifestPath) === '.'
                    ? path.basename(sbomFile).replace(/\.(trivy\.)?cdx\.json$/, '')
                    : path.dirname(manifestPath),
                version: c.version ?? 'unknown',
                path: manifestPath,
                allComponents: false,
            }
        })
    }

    // Syft shape: one project for the entire SBOM.
    return [{
        ref: rootRef ?? '',
        name: path.basename(sbomFile).replace(/\.(trivy\.)?cdx\.json$/, ''),
        version: bom.metadata?.component?.version ?? 'unknown',
        path: sbomFile,
        allComponents: true,
    }]
}

/**
 * Collects every ref reachable from a starting ref, following dependsOn edges.
 * Cycles are possible in real dependency graphs, so visited-tracking is required, not defensive.
 */
function reachableFrom(startRef: string, edges: Map<string, string[]>): Set<string> {
    const seen = new Set<string>()
    const queue = [startRef]
    while (queue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const current = queue.pop()!
        for (const next of edges.get(current) ?? []) {
            if (!seen.has(next)) {
                seen.add(next)
                queue.push(next)
            }
        }
    }
    return seen
}

/**
 * Parses one CycloneDX file into DepinderProjects, keeping only components of `purlType`.
 *
 * One SBOM spans several ecosystems (on Zeppelin: maven, npm, gem, pypi), but a depinder Plugin
 * has exactly one registrar and one advisory ecosystem. So the SBOM is read once per ecosystem and
 * filtered, which lets each ecosystem reuse its existing registrar unchanged.
 */
export function parseCycloneDxFile(sbomFile: string, purlType: string): DepinderProject[] {
    const bom = JSON.parse(fs.readFileSync(sbomFile).toString()) as CycloneDxBom

    const components = bom.components ?? []
    const byRef = new Map<string, CycloneDxComponent>(components.map(c => [c['bom-ref'], c]))

    const edges = new Map<string, string[]>()
    for (const entry of bom.dependencies ?? []) {
        if (entry.dependsOn?.length) edges.set(entry.ref, entry.dependsOn)
    }

    const projectNodes = findProjectNodes(bom, byRef, sbomFile)
    const projects: DepinderProject[] = []

    for (const node of projectNodes) {
        const projectId = `${node.name}@${node.version}`
        const inScope = node.allComponents
            ? new Set(byRef.keys())
            : reachableFrom(node.ref, edges)

        // Resolve each in-scope ref to a purl of the requested ecosystem.
        const parsedByRef = new Map<string, ParsedPurl>()
        for (const ref of inScope) {
            const component = byRef.get(ref)
            if (!component?.purl) continue // no purl -> not a package (GitHub Actions, directories)
            const parsed = parsePurl(component.purl)
            if (parsed && parsed.type === purlType) parsedByRef.set(ref, parsed)
        }

        if (parsedByRef.size === 0) continue

        const dependencies: { [id: string]: DepinderDependency } = {}
        const idOf = (ref: string) => {
            const parsed = parsedByRef.get(ref)
            return parsed ? `${parsed.name}@${parsed.version}` : undefined
        }

        for (const [ref, parsed] of parsedByRef) {
            const component = byRef.get(ref)
            const license = component && firstLicense(component)
            const id = `${parsed.name}@${parsed.version}`

            // The same package can appear under several bom-refs when it was found in several
            // locations, and those copies do not always agree: on Zeppelin, 31 purls are duplicated
            // and in 11 of them only some copies carry a license. Merging rather than overwriting
            // keeps whichever copy knows the license, instead of whichever happened to come last.
            const existing = dependencies[id]
            if (existing) {
                if (license && !existing.libraryInfo) {
                    existing.libraryInfo = {name: parsed.name, licenses: [license], versions: []}
                }
                continue
            }

            dependencies[id] = {
                id,
                name: parsed.name,
                version: parsed.version,
                semver: toSemVer(parsed.version),
                requestedBy: [],
                // `type` (dev/test/provided) is deliberately absent: neither Syft nor Trivy emits
                // dependency scope in any format, so there is nothing to fill it from.
                libraryInfo: license ? {
                    name: parsed.name,
                    licenses: [license],
                    versions: [],
                } : undefined,
            }
        }

        // Invert dependsOn into requestedBy. Edges whose source is outside this ecosystem are
        // attributed to the project itself, so a maven dep pulled in under a project node still
        // reads as direct rather than orphaned.
        for (const [source, targets] of edges) {
            if (source !== node.ref && !parsedByRef.has(source)) continue
            const sourceId = source === node.ref ? projectId : idOf(source)
            if (!sourceId) continue
            for (const target of targets) {
                const targetId = idOf(target)
                if (!targetId || targetId === sourceId) continue
                const requestedBy: string[] = dependencies[targetId].requestedBy
                if (!requestedBy.includes(sourceId)) requestedBy.push(sourceId)
            }
        }

        projects.push({
            name: node.name,
            version: node.version,
            path: node.path,
            dependencies,
        })
    }

    log.info(`Parsed ${projects.length} ${purlType} project(s) from ${path.basename(sbomFile)}`)
    return projects
}
