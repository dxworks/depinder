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
import {originFor} from './origins'

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
 * Syft SBOMs carry chains only where they carry edges — yarn workspaces (see
 * `YARN_WORKSPACE_VERSION`) and the maven reconstruction. Everything a workspace does not reach,
 * and every component of an ecosystem Syft records flat, is emitted at the root level with a
 * one-hop path. That is a real loss of information relative to a Trivy SBOM, not a modelling
 * choice — see the README.
 */

export interface SbomPath {
    /** `name` and `version` of the component this path ends at, so the caller can key on it. */
    name: string
    version: string
    purlType: string
    /** `<repo>/-<package manager>/<name>/<version>/…` — the chain, as Black Duck writes it. */
    path: string
    /** `<repo>`, or `<repo>/<module>` when the SBOM names its modules. */
    projectPath: string
    matchType: 'Direct' | 'Transitive'
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

export function packageManagerTag(manifest: string | undefined): string | undefined {
    if (!manifest) return undefined
    const base = path.basename(manifest)
    return PACKAGE_MANAGER_TAGS.find(([pattern]) => pattern.test(base))?.[1]
}

/** The shortest chain of refs from `start` to every ref reachable from it (`start` itself: `[]`). */
function shortestChains(start: string, edges: Map<string, string[]>): Map<string, string[]> {
    const chains = new Map<string, string[]>([[start, []]])
    const queue = [start]
    while (queue.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const current = queue.shift()!
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const chain = chains.get(current)!
        for (const next of edges.get(current) ?? []) {
            if (chains.has(next)) continue
            chains.set(next, [...chain, next])
            queue.push(next)
        }
    }
    return chains
}

/** The paths of one project, for one ecosystem. */
function projectPaths(graph: BomGraph, node: ProjectNode, repo: string, purlType: string): SbomPath[] {
    const coordinatesOf = (ref: string): ParsedPurl | undefined => {
        const purl = graph.byRef.get(ref)?.purl
        const parsed = purl ? parsePurl(purl) : undefined
        return parsed && parsed.type === purlType ? parsed : undefined
    }
    const projectPath = node.module ? `${repo}/${node.module}` : repo
    const anchors = new Set(node.anchorRefs)
    // Trivy's node is the manifest; a Syft component knows the manifest it was read from.
    const tagOf = (ref: string, target: ParsedPurl) =>
        packageManagerTag(node.path)
        ?? packageManagerTag(locationOf(graph.byRef.get(ref) ?? {'bom-ref': ref}))
        ?? originFor(purlType, target.name).name

    const results: SbomPath[] = []
    const seen = new Set<string>()
    const emit = (chain: string[]) => {
        const target = coordinatesOf(chain[chain.length - 1])
        if (!target) return
        const segments = chain
            .filter(ref => !anchors.has(ref))
            .map(coordinatesOf)
            .filter((it): it is ParsedPurl => !!it)
        if (segments.length === 0) return
        const rendered = `${projectPath}/-${tagOf(chain[chain.length - 1], target)}/`
            + segments.map(it => `${it.name}/${it.version}`).join('/')
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
            matchType: segments.length === 1 ? 'Direct' : 'Transitive',
        })
    }

    // A Trivy project is walked from its manifest node; a Syft one from each workspace it holds.
    const starts = node.allComponents ? node.anchorRefs : [node.ref]
    const reached = new Set<string>()
    for (const start of starts) {
        for (const [ref, chain] of shortestChains(start, graph.edges)) {
            if (ref === start) continue
            reached.add(ref)
            emit(chain)
        }
    }

    // Syft's flat shape: whatever no workspace reaches sits at the root level.
    if (node.allComponents) {
        for (const ref of graph.byRef.keys()) {
            if (!reached.has(ref) && !anchors.has(ref)) emit([ref])
        }
    }
    return results
}

/**
 * Every (component, path) pair in one SBOM, restricted to the purl types being exported. `repo`
 * is the label the chain starts from — the project name, which is what Black Duck puts first.
 */
export function sbomPaths(sbomFile: string, repo: string, purlTypes: Set<string>): SbomPath[] {
    let graph: BomGraph
    try {
        graph = readBomGraph(sbomFile)
    } catch (e: any) {
        log.warn(`Could not read ${path.basename(sbomFile)} for dependency paths: ${e?.message ?? e}`)
        return []
    }
    return [...purlTypes].flatMap(purlType =>
        findProjectNodes(graph, sbomFile, purlType).flatMap(node => projectPaths(graph, node, repo, purlType)))
}
