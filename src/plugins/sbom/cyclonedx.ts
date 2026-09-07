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
 *    does not appear in the dependency graph. For maven, module boundaries are reconstructed from
 *    each component's `syft:location:0:path` property (see findSyftMavenModules); for every other
 *    ecosystem, and whenever reconstruction finds nothing, a Syft SBOM maps to a single project.
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

/** A BOM with its two lookups built: components by bom-ref, and dependsOn edges by source ref. */
export interface BomGraph {
    bom: CycloneDxBom
    byRef: Map<string, CycloneDxComponent>
    edges: Map<string, string[]>
}

export function readBomGraph(sbomFile: string): BomGraph {
    const bom = JSON.parse(fs.readFileSync(sbomFile, 'utf8')) as CycloneDxBom
    const byRef = new Map<string, CycloneDxComponent>((bom.components ?? []).map(c => [c['bom-ref'], c]))
    const edges = new Map<string, string[]>()
    for (const entry of bom.dependencies ?? []) {
        if (entry.dependsOn?.length) edges.set(entry.ref, entry.dependsOn)
    }
    return {bom, byRef, edges}
}

/** `ruby-mastodon.trivy.cdx.json` and `ruby-mastodon.cdx.json` are both the project `ruby-mastodon`. */
export function projectNameOf(sbomFile: string): string {
    return path.basename(sbomFile).replace(/\.(trivy\.)?cdx\.json$/, '')
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

/** The manifest a component was read from — Syft records it; Trivy's components carry none. */
export function locationOf(component: CycloneDxComponent): string | undefined {
    return component.properties?.find(p => p.name === 'syft:location:0:path')?.value
}

/**
 * Parses a component's purl, supplying the component's own `version` field when the purl carries
 * none. Syft emits versionless purls (with `version: 'UNKNOWN'` on the component) for dependencies
 * whose version it could not resolve — on Zeppelin, 23 real maven dependencies whose version lives
 * in a `dependencyManagement` block. Trivy's rare versionless purls carry no component version
 * either, so this fallback never fires for them.
 */
function parseComponentPurl(component: CycloneDxComponent): ParsedPurl | undefined {
    if (!component.purl) return undefined
    const direct = parsePurl(component.purl)
    if (direct) return direct
    if (!component.version) return undefined
    const base = component.purl.split('?')[0].split('#')[0]
    return parsePurl(`${base}@${encodeURIComponent(component.version)}`)
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

/**
 * A project found in a BOM: the node its dependency walk starts from, and what it is called. The
 * export's dependency paths start from the same nodes, so that `Direct` in `_dependencies.csv`
 * and a one-segment `Path` in `_dependencies_sources.csv` can never disagree.
 */
export interface ProjectNode {
    ref: string
    /** The module directory (`neo4j` for `neo4j/pom.xml`); empty for a top-level manifest. */
    module: string
    /** `module`, or the SBOM's own basename for a top-level manifest. */
    name: string
    version: string
    path: string
    /**
     * True for the Syft shape, where the root is a `file` node that carries no dependsOn edges.
     * Reachability from it yields nothing, so the scope is the whole BOM.
     */
    allComponents: boolean
    /**
     * The project's own artifacts inside the graph — the nodes whose outgoing edges are the
     * project's direct dependencies, and which are not dependencies themselves. See
     * `SELF_ANCHORED_MANIFESTS` and `YARN_WORKSPACE_VERSION` for where they come from.
     */
    anchorRefs: string[]
}

/**
 * Manifests under which Trivy nests the project's OWN artifact between the application node and
 * the real dependencies:
 *
 *     markdown/pom.xml -> org.apache.zeppelin:zeppelin-markdown -> real deps
 *     go.mod           -> github.com/caddyserver/caddy/v2       -> real deps
 *     Cargo.lock       -> ripgrep@15.2.0                        -> real deps
 *
 * Reading the application node's children as "direct" would yield exactly one direct dependency
 * per project — the project itself — so the walk is re-rooted on that self-anchor. Lockfiles of
 * the other ecosystems (yarn.lock, Gemfile.lock, composer.lock, ...) list the dependencies flat
 * under the application node and must not be re-rooted: a project with a single direct dependency
 * would otherwise lose it.
 */
const SELF_ANCHORED_MANIFESTS = ['pom.xml', 'go.mod', 'Cargo.lock']

/**
 * Yarn berry resolves a `workspace:` entry to this version in yarn.lock, and Syft copies it into
 * the SBOM verbatim. It is the one marker in either tool's output that a component is the project
 * itself rather than a dependency of it, and a workspace's `dependsOn` edges are the packages its
 * package.json declares — which is what Black Duck calls Direct. Trivy drops the workspace entries
 * and instead marks direct whatever nothing else depends on; nothing in its SBOM can say better.
 */
const YARN_WORKSPACE_VERSION = '0.0.0-use.local'

/**
 * The self-anchors under a Trivy application node.
 *
 * Rule (validated 67/67 on the real Zeppelin SBOM): a child of a self-anchored manifest's node is
 * the self-anchor iff it is the SOLE child, OR it has outgoing dependsOn edges. Children that are
 * neither (e.g. a versionless leaf sitting directly under the application node) are genuine direct
 * dependencies and must stay. This applies only to DIRECT children of the application node — the
 * same artifact deeper in another module's subtree is a real dep.
 */
function selfAnchorsOf(applicationRef: string, manifest: string, edges: Map<string, string[]>): string[] {
    if (!SELF_ANCHORED_MANIFESTS.some(it => manifest === it || manifest.endsWith(`/${it}`))) return []
    const children = edges.get(applicationRef) ?? []
    return children.filter(child => children.length === 1 || (edges.get(child)?.length ?? 0) > 0)
}

/** Syft's yarn-berry workspace nodes of this ecosystem, when the SBOM carries any. */
function workspaceAnchorsOf(bom: CycloneDxBom, edges: Map<string, string[]>, purlType: string): string[] {
    return (bom.components ?? [])
        .filter(c => c.version === YARN_WORKSPACE_VERSION && edges.has(c['bom-ref']))
        .filter(c => parseComponentPurl(c)?.type === purlType)
        .map(c => c['bom-ref'])
}

/**
 * Reconstructs one project per Maven module from a Syft SBOM, which is otherwise flat.
 *
 * Syft records where each component was first seen as a `syft:location:0:path` property (every
 * non-file component carries exactly one). The reconstruction, validated 67/67 against pom-derived
 * ground truth on Apache Zeppelin:
 *
 *  1. Group maven components by that location; keep only groups whose path is a `pom.xml`. Each
 *     such group corresponds to one module.
 *  2. Bootstrap the monorepo's groupId from the SBOM itself: score each purl groupId by the number
 *     of groups in which it occurs EXACTLY once, and take the highest. The module's own artifact
 *     appears once per pom, while shared third-party groups (org.slf4j, ...) repeat within groups.
 *     Degenerate purls are skipped: when Syft cannot resolve a groupId it emits
 *     `pkg:maven/<name>/<name>@v` (namespace equal to the artifact name), which says nothing.
 *  3. In each group the anchor is the unique component whose groupId is the monorepo groupId.
 *     Defensive tie-breaks if several match: prefer one that is the target of no dependsOn edge,
 *     then one carrying the modal candidate version across groups.
 *
 * Membership is deliberately NOT the location group: Syft dedups components repo-wide, so a
 * component's location is merely where it was first seen. The module's dependency set is the
 * dependsOn-reachability from its anchor, exactly like the Trivy path.
 *
 * Returns undefined when no pom groups exist or no groupId can be bootstrapped (non-monorepo or
 * non-maven SBOM), so the caller falls back to the single-project shape.
 */
function findSyftMavenModules(
    bom: CycloneDxBom,
    edges: Map<string, string[]>,
    sbomFile: string,
): ProjectNode[] | undefined {
    interface Candidate {
        ref: string
        groupId: string
        artifact: string
        version: string
        degenerate: boolean
    }

    // 1. Group maven components by their Syft location, keeping pom.xml groups only.
    //    Both `flink/pom.xml` and `/flink/pom.xml` forms occur in the wild.
    const pomGroups = new Map<string, Candidate[]>()
    for (const component of bom.components ?? []) {
        const parsed = parseComponentPurl(component)
        if (!parsed || parsed.type !== 'maven') continue
        const location = locationOf(component)
        if (!location || !(location === 'pom.xml' || location.endsWith('/pom.xml'))) continue

        const colon = parsed.name.indexOf(':')
        const groupId = parsed.name.slice(0, colon)
        const artifact = parsed.name.slice(colon + 1)
        const group = pomGroups.get(location) ?? []
        group.push({
            ref: component['bom-ref'],
            groupId,
            artifact,
            version: parsed.version,
            degenerate: groupId === artifact,
        })
        pomGroups.set(location, group)
    }
    if (pomGroups.size === 0) return undefined

    // 2. Bootstrap the monorepo groupId: +1 per group where the groupId occurs exactly once.
    const score = new Map<string, number>()
    for (const group of pomGroups.values()) {
        const occurrences = new Map<string, number>()
        for (const c of group) {
            if (c.degenerate) continue
            occurrences.set(c.groupId, (occurrences.get(c.groupId) ?? 0) + 1)
        }
        for (const [groupId, n] of occurrences) {
            if (n === 1) score.set(groupId, (score.get(groupId) ?? 0) + 1)
        }
    }
    let monoGroupId: string | undefined
    let bestScore = 0
    for (const [groupId, n] of score) {
        if (n > bestScore) {
            bestScore = n
            monoGroupId = groupId
        }
    }
    if (!monoGroupId) return undefined

    // Tie-break inputs: refs that are the target of any dependsOn edge, and the modal version
    // among anchor candidates across all groups.
    const edgeTargets = new Set<string>()
    for (const targets of edges.values()) {
        for (const target of targets) edgeTargets.add(target)
    }
    const versionCounts = new Map<string, number>()
    for (const group of pomGroups.values()) {
        for (const c of group) {
            if (c.groupId === monoGroupId) versionCounts.set(c.version, (versionCounts.get(c.version) ?? 0) + 1)
        }
    }
    let modalVersion: string | undefined
    let modalCount = 0
    for (const [version, n] of versionCounts) {
        if (n > modalCount) {
            modalCount = n
            modalVersion = version
        }
    }

    // 3. Pick each group's anchor and derive the project from it.
    const nodes: ProjectNode[] = []
    for (const [pomPath, group] of pomGroups) {
        let anchors = group.filter(c => c.groupId === monoGroupId)
        if (anchors.length > 1) {
            const rootLike = anchors.filter(c => !edgeTargets.has(c.ref))
            if (rootLike.length > 0) anchors = rootLike
        }
        if (anchors.length > 1 && modalVersion) {
            const modal = anchors.filter(c => c.version === modalVersion)
            if (modal.length > 0) anchors = modal
        }
        if (anchors.length === 0) continue // a pom group with no in-monorepo artifact is not a module
        const anchor = anchors[0]

        // The Syft anchor IS the project node: the walk starts from it.
        nodes.push({
            ref: anchor.ref,
            ...moduleNames(pomPath.replace(/^\//, ''), sbomFile),
            version: anchor.version,
            path: pomPath,
            allComponents: false,
            anchorRefs: [anchor.ref],
        })
    }
    return nodes.length > 0 ? nodes : undefined
}

/** `neo4j/pom.xml` -> module `neo4j`; a top-level `pom.xml` -> no module, named after the SBOM. */
function moduleNames(manifestPath: string, sbomFile: string): {module: string, name: string} {
    const dir = path.dirname(manifestPath)
    const module = dir === '.' ? '' : dir
    return {module, name: module || projectNameOf(sbomFile)}
}

/**
 * Identifies the project nodes in a BOM, for one ecosystem.
 *
 * Trivy: the root's direct children of type `application` (one per manifest file), re-rooted on
 *        their self-anchor where the manifest nests one (SELF_ANCHORED_MANIFESTS).
 * Syft:  no project nodes exist. For maven, per-module reconstruction from Syft's location
 *        properties (findSyftMavenModules); otherwise one project spanning the whole BOM, whose
 *        direct dependencies are the yarn workspaces' declared ones when the SBOM carries
 *        workspace nodes (YARN_WORKSPACE_VERSION).
 */
export function findProjectNodes({bom, byRef, edges}: BomGraph, sbomFile: string, purlType: string): ProjectNode[] {
    const rootRef = bom.metadata?.component?.['bom-ref']
    const rootChildren = rootRef ? edges.get(rootRef) ?? [] : []

    const applicationChildren = rootChildren
        .map(ref => byRef.get(ref))
        .filter((c): c is CycloneDxComponent => !!c && c.type === 'application' && !c.purl)

    if (applicationChildren.length > 0) {
        return applicationChildren.map(c => {
            const manifestPath = c.name ?? 'unknown'
            return {
                ref: c['bom-ref'],
                ...moduleNames(manifestPath, sbomFile),
                version: c.version ?? 'unknown',
                path: manifestPath,
                allComponents: false,
                anchorRefs: selfAnchorsOf(c['bom-ref'], manifestPath, edges),
            }
        })
    }

    // Syft shape. For maven, try to reconstruct one project per module first; other ecosystems
    // keep the single-project behavior (no equivalent rule has been validated for them yet).
    if (purlType === 'maven') {
        const modules = findSyftMavenModules(bom, edges, sbomFile)
        if (modules) return modules
    }

    // Syft shape, no reconstructable modules: one project for the entire SBOM.
    return [{
        ref: rootRef ?? '',
        module: '',
        name: projectNameOf(sbomFile),
        version: bom.metadata?.component?.version ?? 'unknown',
        path: sbomFile,
        allComponents: true,
        anchorRefs: workspaceAnchorsOf(bom, edges, purlType),
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
    const graph = readBomGraph(sbomFile)
    const {byRef, edges} = graph

    const projectNodes = findProjectNodes(graph, sbomFile, purlType)
    const projects: DepinderProject[] = []

    for (const node of projectNodes) {
        const projectId = `${node.name}@${node.version}`
        const inScope = node.allComponents
            ? new Set(byRef.keys())
            : reachableFrom(node.ref, edges)

        // The project's own artifacts: their outgoing edges are the project's direct dependencies,
        // and they are kept out of the dependency map themselves.
        const anchorRefs = new Set<string>(node.anchorRefs)

        // Resolve each in-scope ref to a purl of the requested ecosystem.
        const parsedByRef = new Map<string, ParsedPurl>()
        for (const ref of inScope) {
            const component = byRef.get(ref)
            if (!component?.purl) continue // no purl -> not a package (GitHub Actions, directories)
            const parsed = parseComponentPurl(component)
            if (parsed && parsed.type === purlType) parsedByRef.set(ref, parsed)
        }

        const dependencies: { [id: string]: DepinderDependency } = {}
        const idOf = (ref: string) => {
            const parsed = parsedByRef.get(ref)
            return parsed ? `${parsed.name}@${parsed.version}` : undefined
        }

        // The self-anchor is the module itself, not a dependency of it — keep it out of the map
        // entirely (by id, so a duplicate bom-ref for the same artifact cannot sneak it back in).
        const anchorIds = new Set<string>()
        for (const ref of anchorRefs) {
            // A Syft anchor is the traversal's start, so it sits OUTSIDE its own reachable set and
            // parsedByRef does not know it — parse its purl directly in that case.
            let parsed = parsedByRef.get(ref)
            if (!parsed) {
                const component = byRef.get(ref)
                const fromPurl = component ? parseComponentPurl(component) : undefined
                if (fromPurl && fromPurl.type === purlType) parsed = fromPurl
            }
            if (parsed) anchorIds.add(`${parsed.name}@${parsed.version}`)
        }

        // Nothing of this ecosystem is in scope AND the module itself is not of this ecosystem:
        // the project simply does not exist for this purl type. (A module whose ONLY in-ecosystem
        // component is its own anchor stays, as an empty project — see the note above `projects.push`.)
        if (parsedByRef.size === 0 && anchorIds.size === 0) continue

        for (const [ref, parsed] of parsedByRef) {
            const component = byRef.get(ref)
            const license = component && firstLicense(component)
            const id = `${parsed.name}@${parsed.version}`
            if (anchorIds.has(id)) continue

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
            if (source !== node.ref && !anchorRefs.has(source) && !parsedByRef.has(source)) continue
            // Edges out of the self-anchor are the module's true direct dependencies — attribute
            // them to the project id, exactly as if the application node pointed at them itself.
            const sourceId = source === node.ref || anchorRefs.has(source)
                ? projectId
                : idOf(source)
            if (!sourceId) continue
            for (const target of targets) {
                const targetId = idOf(target)
                if (!targetId || targetId === sourceId || anchorIds.has(targetId)) continue
                const requestedBy: string[] = dependencies[targetId].requestedBy
                if (!requestedBy.includes(sourceId)) requestedBy.push(sourceId)
            }
        }

        // Excluding the anchor can leave a module with zero dependencies (its only in-ecosystem
        // component was its own artifact). Keep the project: an empty module is a true result,
        // and hiding it would silently shrink the project list. On Zeppelin this affects 8 of 67.
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
