import fs from 'fs'
import path from 'path'
import {CycloneDxBom, CycloneDxComponent, parsePurl} from '../plugins/sbom/cyclonedx'
import {log} from '../utils/logging'

/**
 * The `Path` column of `_dependencies_sources.csv`: where in the dependency graph a component was
 * reached from.
 *
 * Black Duck writes one row per (component, path) — 11,418 rows against 9,037 components in the
 * reference export — so a component pulled in by two different parents appears twice, with the
 * two chains that reached it. The chain is read off the SBOM's own `dependencies[].dependsOn`
 * edges, which is the only place this information exists: the depinder dependency model records
 * `requestedBy` but not the route back to the root.
 *
 * Two decisions are worth stating, because neither is forced by the data:
 *
 *  - *Which* paths. Enumerating every distinct root-to-component route is exponential in a real
 *    graph (npm graphs have millions), and Black Duck plainly does not do it either. So one row
 *    is emitted per (component, immediate parent): the shortest route to that parent, extended by
 *    the component. That is bounded by the edge count, is stable under re-runs, and reproduces
 *    the property the column exists for — "which of my dependencies brought this in".
 *
 *  - Syft SBOMs. Syft emits no project node and, outside the maven reconstruction, no dependency
 *    edges either: its root is a `file` node that depends on nothing. There is no chain to walk,
 *    so every component is emitted at the root level with a one-hop path. This is a real loss of
 *    information relative to a Trivy SBOM, not a modelling choice — see the README.
 */

export interface SbomPath {
    /** `name` and `version` of the component this path ends at, so the caller can key on it. */
    name: string
    version: string
    purlType: string
    /** `<repo>/-<origin>/<name>/<version>/…` — the chain, as Black Duck writes it. */
    path: string
    /** `<repo>`, or `<repo>/<module>` when the SBOM names its modules. */
    projectPath: string
    matchType: 'Direct' | 'Transitive'
}

/** A project anchor in the SBOM: Trivy's `application` nodes, or the BOM root for Syft. */
interface Anchor {
    ref: string
    /** The module label, empty for a single-project SBOM. */
    module: string
}

function anchorsOf(bom: CycloneDxBom, byRef: Map<string, CycloneDxComponent>, edges: Map<string, string[]>): Anchor[] {
    const rootRef = bom.metadata?.component?.['bom-ref'] ?? ''
    const applications = (edges.get(rootRef) ?? [])
        .map(ref => byRef.get(ref))
        .filter((it): it is CycloneDxComponent => !!it && it.type === 'application' && !it.purl)
    if (applications.length === 0) return [{ref: rootRef, module: ''}]
    return applications.map(it => ({
        ref: it['bom-ref'],
        // `neo4j/pom.xml` -> `neo4j`; a manifest at the top level contributes no module segment.
        module: path.dirname(it.name ?? '.') === '.' ? '' : path.dirname(it.name ?? '.'),
    }))
}

/** The shortest chain of components from an anchor to every ref reachable from it. */
function shortestChains(anchorRef: string, edges: Map<string, string[]>): Map<string, string[]> {
    const chains = new Map<string, string[]>([[anchorRef, []]])
    const queue = [anchorRef]
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

/**
 * Every (component, path) pair in one SBOM, restricted to the purl types being exported.
 *
 * `repo` is the label the chain starts from — the project name, which is what Black Duck puts
 * first — and `originOf` supplies the `-<origin>` segment that follows it.
 */
export function sbomPaths(
    sbomFile: string,
    repo: string,
    purlTypes: Set<string>,
    originOf: (purlType: string) => string
): SbomPath[] {
    let bom: CycloneDxBom
    try {
        bom = JSON.parse(fs.readFileSync(sbomFile, 'utf8')) as CycloneDxBom
    } catch (e: any) {
        log.warn(`Could not read ${path.basename(sbomFile)} for dependency paths: ${e?.message ?? e}`)
        return []
    }

    const byRef = new Map<string, CycloneDxComponent>((bom.components ?? []).map(it => [it['bom-ref'], it]))
    const edges = new Map<string, string[]>()
    for (const entry of bom.dependencies ?? []) {
        if (entry.dependsOn?.length) edges.set(entry.ref, entry.dependsOn)
    }

    const coordinatesOf = (ref: string) => {
        const purl = byRef.get(ref)?.purl
        const parsed = purl ? parsePurl(purl) : undefined
        return parsed && purlTypes.has(parsed.type) ? parsed : undefined
    }

    const results: SbomPath[] = []
    const seen = new Set<string>()

    for (const anchor of anchorsOf(bom, byRef, edges)) {
        const projectPath = anchor.module ? `${repo}/${anchor.module}` : repo
        const chains = shortestChains(anchor.ref, edges)

        const emit = (parentRef: string, childRef: string) => {
            const target = coordinatesOf(childRef)
            if (!target) return
            const chain = [...(chains.get(parentRef) ?? []), childRef]
            const segments = chain.map(coordinatesOf).filter((it): it is NonNullable<typeof it> => !!it)
            if (segments.length === 0) return
            const rendered = `${projectPath}/-${originOf(target.type)}/`
                + segments.map(it => `${it.name}/${it.version}`).join('/')
            const key = `${target.type}|${target.name}|${target.version}|${rendered}`
            if (seen.has(key)) return
            seen.add(key)
            results.push({
                name: target.name,
                version: target.version,
                purlType: target.type,
                path: rendered,
                projectPath,
                matchType: parentRef === anchor.ref ? 'Direct' : 'Transitive',
            })
        }

        if (chains.size > 1) {
            // Every edge whose source this anchor can reach, so a component pulled in by two
            // parents is reported under both.
            for (const [source, targets] of edges) {
                if (!chains.has(source)) continue
                for (const target of targets) emit(source, target)
            }
        } else {
            // Syft's shape: no edges out of the root. Every component sits at the root level.
            for (const ref of byRef.keys()) emit(anchor.ref, ref)
        }
    }
    return results
}
