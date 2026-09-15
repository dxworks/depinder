import path from 'path'
import {
    BomGraph,
    findProjectNodes,
    locationOf,
    ParsedPurl,
    parsePurl,
    ProjectNode,
    readBomGraph,
} from '../plugins/sbom/cyclonedx'
import {log} from '../utils/logging'
import {blackDuckPrefix, manifestOfTree, ownCodeMatcher, readRepoManifests, RepoManifests} from './manifests'
import {originFor, pathSegment} from './origins'

/**
 * The `Path` column of `_dependencies_sources.csv`: where in the dependency graph a component was
 * reached from.
 *
 * Black Duck writes ONE row per (component, project) — the shortest chain from the project's
 * manifest to the component, 1,122 rows for ruby-mastodon's 1,239 components — so a component
 * pulled in by two parents appears once, under whichever parent reaches it soonest. The chain is
 * read off the SBOM's own `dependencies[].dependsOn` edges, which is the only place this
 * information exists: the depinder dependency model records `requestedBy` but not the route back
 * to the root.
 *
 * The walk starts from the same project nodes the parser builds projects from (`findProjectNodes`),
 * with the same self-anchors: a project's own artifact is not a segment of its own paths, and a
 * one-segment path here means exactly what `Direct` means in `_dependencies.csv`.
 *
 * A Syft SBOM has no manifest node to walk from: its `metadata.component` is a `file` and never
 * appears in `dependencies[]`. It is walked instead from every ref nothing points at, together
 * with the yarn workspace anchors (see `YARN_WORKSPACE_VERSION`) and the maven reconstruction.
 * Only what remains unreached — a ref inside a cycle, or an ecosystem Syft genuinely records flat,
 * as it does for Go — is emitted at the root level with a one-hop path.
 */

export interface SbomPath {
    /** `name` and `version` of the component this path ends at, so the caller can key on it. */
    name: string
    version: string
    purlType: string
    /**
     * `<repo>/-<package manager>/<name>/<version>/…` — the chain, as Black Duck writes it
     * (`<name>:<version>` where the origin id uses a colon). With the scanned repository on disk
     * (`--target`) the prefix is Black Duck's project prefix, `<name>/<version>/<repo>/…`; see
     * `blackDuckPrefix`.
     */
    path: string
    /** `<repo>`, or `<repo>/<module>` when the SBOM names its modules. */
    projectPath: string
    matchType: 'Direct Dependency' | 'Transitive Dependency'
}

/**
 * One parent-child edge of one tree, for `_dependency_edges.csv`.
 *
 * `Path` answers "where was this component reached from", one chain per component, because that is
 * the shape Black Duck exports. It is not the graph: a component with three parents keeps one. The
 * edge table is the graph — every edge the SBOM records — which is what a tree-to-tree comparison
 * against ground truth needs.
 */
export interface SbomEdge {
    /** The repo the SBOM describes; one export folder can hold several. */
    repo: string
    /** `<repo>/<module>/-<package manager>` — the tree this edge belongs to. */
    tree: string
    purlType: string
    /** The parent's origin id, or `(root)` for a component nothing in the tree pulls in. */
    parent: string
    child: string
    /** The child's shortest distance from a root of its tree; a direct dependency is 1. */
    depth: number
}

/**
 * Black Duck tags every path with the package manager whose manifest it walked — `-yarn`, not
 * `-npmjs` — so the same registry appears under three tags in one export (`-yarn`, `-npm`,
 * `-pnpm`). The tag is read off the manifest's basename, which both tools record: Trivy names its
 * application node after the manifest, Syft records each component's `syft:location:0:path`.
 * Every tag below was read off the reference export, except `poetry`, which follows the pattern.
 */
const PACKAGE_MANAGER_TAGS: readonly [RegExp, string][] = [
    [/^yarn\.lock$/, 'yarn'],
    [/^package(-lock)?\.json$/, 'npm'],
    [/^pnpm-lock\.yaml$/, 'pnpm'],
    [/^(Gemfile(\.lock)?|.*\.gemspec)$/, 'rubygems'],
    [/^pom\.xml$/, 'maven'],
    [/^(build\.gradle(\.kts)?|gradle\.lockfile)$/, 'gradle'],
    [/^composer\.(json|lock)$/, 'packagist'],
    [/^Cargo\.(toml|lock)$/, 'cargo'],
    [/^go\.(mod|sum)$/, 'go_mod'],
    [/^(packages\.lock\.json|.*\.(csproj|fsproj|vbproj|deps\.json))$/, 'nuget'],
    [/^uv\.lock$/, 'uv'],
    [/^poetry\.lock$/, 'poetry'],
    [/^(requirements.*\.txt|Pipfile(\.lock)?)$/, 'pip'],
]

/** What a component with no parent inside its tree is filed under, as `comparison-view` spells it. */
export const EDGE_ROOT = '(root)'

export function packageManagerTag(manifest: string | undefined): string | undefined {
    if (!manifest) return undefined
    const base = path.basename(manifest)
    return PACKAGE_MANAGER_TAGS.find(([pattern]) => pattern.test(base))?.[1]
}

/**
 * The shortest chain of refs from `start` to every ref reachable from it, `start` included as the
 * chain's first segment. A start that is an anchor drops out again in `emit`, which filters
 * anchors; a start that is a real package is a direct dependency and has to stay.
 *
 * Where two chains tie on length, Black Duck reports the one through the greater parent — its
 * path to `actionpack` runs through `rspec-rails`, not `active_model_serializers`; to `@emotion/hash`
 * through `@emotion/serialize`, not `@emotion/babel-plugin`. Visiting neighbours in descending
 * order reproduces that: on ruby-mastodon it matched 636 of 800 Black Duck paths against 616 in
 * the SBOM's own edge order (Trivy), and 449 against 426 (Syft).
 */
function shortestChains(start: string, graph: BomGraph): Map<string, string[]> {
    const label = (ref: string) => {
        const component = graph.byRef.get(ref)
        return component ? `${component.name}@${component.version}` : ref
    }
    const chains = new Map<string, string[]>([[start, [start]]])
    const queue = [start]
    while (queue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const current = queue.shift()!
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const chain = chains.get(current)!
        const neighbours = [...(graph.edges.get(current) ?? [])].sort((a, b) => label(b).localeCompare(label(a)))
        for (const next of neighbours) {
            if (chains.has(next)) continue
            chains.set(next, [...chain, next])
            queue.push(next)
        }
    }
    return chains
}

/**
 * The refs no edge points at — where a walk of the graph has to start when nothing else names a
 * root. Syft's `metadata.component` is a `file` and never appears in `dependencies[]`, so for its
 * SBOMs this is the only honest entry point: `js-npm-nest` has 61 such refs, `dotnet-eshoponweb`
 * 382. Where a yarn workspace anchor exists it is itself in-degree zero, so this subsumes the
 * anchors rather than competing with them.
 */
function graphRoots(graph: BomGraph): string[] {
    const pointedAt = new Set<string>()
    for (const children of graph.edges.values()) for (const child of children) pointedAt.add(child)
    return [...graph.edges.keys()].filter(ref => !pointedAt.has(ref))
}

/**
 * The edges of one ecosystem, with the refs of every other ecosystem — and the anchors — contracted
 * away, so `a -> (an application node) -> b` is the single edge `a -> b`. This is the same
 * filtering `emit` does to a chain's segments, done once on the graph instead of once per chain,
 * so a path and an edge can never disagree about who a component's parent is.
 */
function contract(graph: BomGraph, keep: (ref: string) => boolean): Map<string, string[]> {
    const through = new Map<string, string[]>()
    const walking = new Set<string>()
    // The kept refs a foreign ref leads to, looking through further foreign refs. Memoised, and
    // guarded against a cycle among foreign refs, which would otherwise not terminate.
    const beyond = (ref: string): string[] => {
        const done = through.get(ref)
        if (done) return done
        if (walking.has(ref)) return []
        walking.add(ref)
        const out = new Set<string>()
        for (const child of graph.edges.get(ref) ?? []) {
            if (keep(child)) out.add(child)
            else for (const further of beyond(child)) out.add(further)
        }
        walking.delete(ref)
        const result = [...out]
        through.set(ref, result)
        return result
    }
    // Every ref, kept or not: a walk has to be able to start at a manifest node, or at a project's
    // own artifact, and ask which of this ecosystem's components lie beyond it.
    const contracted = new Map<string, string[]>()
    for (const ref of graph.edges.keys()) contracted.set(ref, beyond(ref))
    return contracted
}

/**
 * Every edge of one tree, and how deep each component sits. Roots come first — the starts the paths
 * are walked from, contracted the same way — then a breadth-first walk assigns each component its
 * shortest distance from one. Anything left over is a component inside a cycle or one the SBOM
 * records flat; it becomes a root in turn, which is what the one-hop path fallback does for `Path`.
 */
function treeEdges(
    contracted: Map<string, string[]>, seeds: string[], flat: string[] | undefined,
    render: (ref: string) => string | undefined, treeOf: (ref: string) => string,
    repo: string, purlType: string,
): SbomEdge[] {
    const depth = new Map<string, number>()
    const roots: string[] = []
    const walk = (from: string[]) => {
        const queue = [...from]
        while (queue.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const current = queue.shift()!
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const next = depth.get(current)! + 1
            for (const child of contracted.get(current) ?? []) {
                if (depth.has(child)) continue
                depth.set(child, next)
                queue.push(child)
            }
        }
    }
    const seed = (ref: string) => {
        if (depth.has(ref)) return false
        depth.set(ref, 1)
        roots.push(ref)
        return true
    }
    seeds.forEach(seed)
    walk(roots)
    // Only a project that spans the whole BOM adopts what its seeds do not reach. A Trivy project
    // is one manifest among several in the same graph, and must claim only what it reaches — every
    // manifest adopting every stray component is how one edge becomes one edge per manifest.
    for (const ref of flat ?? []) if (seed(ref)) walk([ref])

    const edges: SbomEdge[] = []
    const seen = new Set<string>()
    const add = (parent: string, child: string) => {
        const childId = render(child)
        if (!childId) return
        const key = `${parent}\u0000${childId}`
        if (seen.has(key)) return
        seen.add(key)
        edges.push({repo, tree: treeOf(child), purlType, parent, child: childId, depth: depth.get(child) ?? 1})
    }
    for (const root of roots) add(EDGE_ROOT, root)
    for (const [parent, children] of contracted) {
        if (!depth.has(parent)) continue
        const parentId = render(parent)
        if (!parentId) continue
        for (const child of children) if (depth.has(child)) add(parentId, child)
    }
    return edges
}

/**
 * The paths and edges of one project, for one ecosystem.
 *
 * With `manifests` — the scanned repository read off disk — two things change in `Path` only,
 * never in the edges: the chain drops the repository's own code (a workspace member, the uv
 * project, the Cargo crate) the way it already drops the anchors, because Black Duck files each
 * of those as a project of its own and starts the chain after it; and the prefix becomes Black
 * Duck's `<name>/<version>/<dir>` where the tree's manifest declares a name. The edge table keeps
 * the graph as the SBOM records it; the own-code rule for edges is the viewer's, applied from the
 * ground truth to every source alike.
 */
function projectTree(graph: BomGraph, node: ProjectNode, repo: string, purlType: string, manifests?: RepoManifests): {paths: SbomPath[], edges: SbomEdge[]} {
    if (node.scopeRefs) {
        const scope = new Set(node.scopeRefs)
        graph = {...graph,
            byRef: new Map([...graph.byRef].filter(([ref]) => scope.has(ref))),
            edges: new Map([...graph.edges].filter(([ref]) => scope.has(ref))
                .map(([ref, children]) => [ref, children.filter(child => scope.has(child))])),
        }
    }
    const coordinatesOf = (ref: string): ParsedPurl | undefined => {
        const purl = graph.byRef.get(ref)?.purl
        const parsed = purl ? parsePurl(purl) : undefined
        return parsed && parsed.type === purlType ? parsed : undefined
    }
    const projectPath = node.module ? `${repo}/${node.module}` : repo
    const anchors = new Set(node.anchorRefs)
    const ownCode = ownCodeMatcher(manifests, node.module, purlType)
    // The project's own artifacts: the anchors the SBOM marks, and what the repository's manifests declare.
    const isOwn = (ref: string) => anchors.has(ref) || ownCode(coordinatesOf(ref))
    // Trivy's node is the manifest; a Syft component knows the manifest it was read from.
    const tagOf = (ref: string, target: ParsedPurl) =>
        packageManagerTag(node.path)
        ?? packageManagerTag(locationOf(graph.byRef.get(ref) ?? {'bom-ref': ref}))
        ?? originFor(purlType, target.name).name
    const prefixOf = (tag: string) => blackDuckPrefix(tag, projectPath, manifestOfTree(manifests, node.module, tag))

    const results: SbomPath[] = []
    const seen = new Set<string>()
    const emit = (chain: string[]) => {
        const last = chain[chain.length - 1]
        const target = coordinatesOf(last)
        // Own code is a project, not a component: Black Duck has no row for it.
        if (!target || isOwn(last)) return
        const segments = chain
            .filter(ref => !isOwn(ref))
            .map(coordinatesOf)
            .filter((it): it is ParsedPurl => !!it)
        if (segments.length === 0) return
        const tag = tagOf(last, target)
        const rendered = `${prefixOf(tag)}-${tag}/`
            + segments.map(it => pathSegment(originFor(purlType, it.name), it.name, it.version)).join('/')
        // Syft lists a package once per location it was seen in; one path per package is enough.
        const key = `${target.name}|${target.version}|${rendered}`
        if (seen.has(key)) return
        seen.add(key)
        results.push({
            name: target.name,
            version: target.version,
            purlType,
            path: rendered,
            projectPath,
            matchType: segments.length === 1 ? 'Direct Dependency' : 'Transitive Dependency',
        })
    }

    // A Trivy project is walked from its manifest node. A Syft one has no manifest node to walk
    // from — its `metadata.component` is a file, absent from `dependencies[]` — so it is walked
    // from every workspace anchor it holds and from every ref nothing points at.
    const starts = node.allComponents
        ? [...new Set([...node.anchorRefs, ...graphRoots(graph)])]
        : [node.ref]
    const reached = new Set<string>()
    for (const start of starts) {
        for (const [, chain] of shortestChains(start, graph)) {
            reached.add(chain[chain.length - 1])
            emit(chain)
        }
    }

    // Whatever no start reaches — a ref inside a cycle, or one the SBOM records flat — sits at the
    // root level with a one-hop path.
    if (node.allComponents) {
        for (const ref of graph.byRef.keys()) {
            if (!reached.has(ref) && !isOwn(ref)) emit([ref])
        }
    }

    // The same graph, as edges rather than chains. `keep` is `emit`'s segment filter: this
    // ecosystem's components, minus the anchors, which are the project's own artefacts.
    const keep = (ref: string) => !anchors.has(ref) && !!coordinatesOf(ref)
    const contracted = contract(graph, keep)
    // A start is a manifest node or a project's own artifact as often as it is a component, so the
    // seeds are what lies beyond it once the other ecosystems and the anchors are contracted away.
    const seeds = starts.flatMap(start => keep(start) ? [start] : (contracted.get(start) ?? []))
    const render = (ref: string) => {
        const it = coordinatesOf(ref)
        return it && pathSegment(originFor(purlType, it.name), it.name, it.version)
    }
    const treeOf = (ref: string) => {
        const it = coordinatesOf(ref)
        return `${projectPath}/-${it ? tagOf(ref, it) : 'unknown'}`
    }
    const flat = node.allComponents ? [...graph.byRef.keys()].filter(keep) : undefined
    return {paths: results, edges: treeEdges(contracted, seeds, flat, render, treeOf, repo, purlType)}
}

/**
 * Every (component, path) pair and every parent-child edge in one SBOM, restricted to the purl
 * types being exported. `repo` is the label the chain starts from — the project name, which is
 * what Black Duck puts first. `repoDir`, when given, is the scanned repository on disk: its
 * manifests supply Black Duck's project prefix and the own-code rule (see `manifests.ts`).
 */
export function sbomTree(sbomFile: string, repo: string, purlTypes: Set<string>, options: {repoDir?: string} = {}): {paths: SbomPath[], edges: SbomEdge[]} {
    let graph: BomGraph
    try {
        graph = readBomGraph(sbomFile)
    } catch (e: any) {
        log.warn(`Could not read ${path.basename(sbomFile)} for dependency paths: ${e?.message ?? e}`)
        return {paths: [], edges: []}
    }
    const manifests = options.repoDir ? readRepoManifests(options.repoDir) : undefined
    if (options.repoDir && !manifests) log.warn(`${options.repoDir} is not a directory; paths of ${path.basename(sbomFile)} get no project prefix`)
    const trees = [...purlTypes].flatMap(purlType =>
        findProjectNodes(graph, sbomFile, purlType).map(node => projectTree(graph, node, repo, purlType, manifests)))
    return {paths: trees.flatMap(it => it.paths), edges: trees.flatMap(it => it.edges)}
}

/** Just the chains, for a caller that only writes the `Path` column. */
export function sbomPaths(sbomFile: string, repo: string, purlTypes: Set<string>, options: {repoDir?: string} = {}): SbomPath[] {
    return sbomTree(sbomFile, repo, purlTypes, options).paths
}
