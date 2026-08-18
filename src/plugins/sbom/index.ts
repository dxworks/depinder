import path from 'path'
import {DependencyFileContext, DepinderProject, Extractor, Parser} from '../../extension-points/extract'
import {Plugin} from '../../extension-points/plugin'
import {parseCycloneDxFile} from './cyclonedx'
import {scanSbomFileOnce} from './local-scan'
import {java} from '../java'
import {javascript} from '../javascript'
import {ruby} from '../ruby'
import {python} from '../python'
import {php} from '../php'
import {dotnet} from '../dotnet'

/**
 * CycloneDX SBOM plugins.
 *
 * A single SBOM spans several ecosystems at once (on Apache Zeppelin: maven, npm, gem, pypi), but a
 * depinder Plugin has exactly one registrar and one advisory ecosystem. So rather than one `sbom`
 * plugin, we register one per ecosystem: each reads the same SBOM files, filters to its own purl
 * type, and reuses the registrar and vulnerability checker of the corresponding native plugin. No
 * registry code is duplicated.
 *
 * Files are matched by suffix so that both tools' outputs are picked up:
 *   <project>.cdx.json        (Syft)
 *   <project>.trivy.cdx.json  (Trivy)
 */

const SBOM_GLOBS = ['*.cdx.json']

/**
 * One SBOM yields many projects (Trivy emits one `application` node per manifest), but
 * ParseDependencyTree must return a single project. So contexts are created per project: the
 * extractor parses each file once to learn how many projects it holds, and encodes the index in
 * `type`. The parser then resolves that index back to a project.
 */
const CONTEXT_TYPE_PREFIX = 'cyclonedx'

/** Parsing the same file for several ecosystems and project indices is common — memoise it. */
const cache = new Map<string, DepinderProject[]>()

function projectsOf(sbomFile: string, purlType: string): DepinderProject[] {
    const key = `${purlType}:${sbomFile}`
    const hit = cache.get(key)
    if (hit) return hit

    const projects = parseCycloneDxFile(sbomFile, purlType)
    cache.set(key, projects)
    return projects
}

function createExtractor(purlType: string): Extractor {
    return {
        files: SBOM_GLOBS,
        createContexts: (files: string[]) => files.flatMap(file =>
            projectsOf(file, purlType).map((_, index) => ({
                root: path.dirname(file),
                lockFile: path.basename(file),
                type: `${CONTEXT_TYPE_PREFIX}:${purlType}:${index}`,
            } as DependencyFileContext))
        ),
    }
}

function createParser(purlType: string): Parser {
    return {
        parseDependencyTree: async (context: DependencyFileContext) => {
            const parts = context.type?.split(':') ?? []
            if (parts[0] !== CONTEXT_TYPE_PREFIX) {
                throw new Error(`Unsupported context type: ${context.type}`)
            }

            const index = Number(parts[2])
            const sbomFile = path.resolve(context.root, context.lockFile)
            const projects = projectsOf(sbomFile, purlType)

            const project = projects[index]
            if (!project) {
                throw new Error(`No ${purlType} project at index ${index} in ${context.lockFile}`)
            }

            // Local vulnerability scan of the SBOM (Trivy + Grype), once per file per process.
            // When at least one scanner ran, its exact-version findings are attached here and win
            // over the GHSA range-filtered path downstream (analyse.ts only fills
            // `vulnerabilities` when the parser left it undefined). When no scanner is available
            // the field stays undefined, so the GHSA path still works with a GH_TOKEN.
            const scan = await scanSbomFileOnce(sbomFile)
            if (scan.available) {
                for (const dep of Object.values(project.dependencies)) {
                    dep.vulnerabilities = scan.index.get(dep.id) ?? []
                }
            }
            return project
        },
    }
}

/**
 * Builds an SBOM plugin for one ecosystem, borrowing the registrar and checker from the native
 * plugin that already knows how to talk to that registry.
 */
function sbomPluginFor(name: string, purlType: string, source: Plugin): Plugin {
    return {
        name,
        aliases: [`sbom-${purlType}`],
        extractor: createExtractor(purlType),
        parser: createParser(purlType),
        registrar: source.registrar,
        checker: source.checker,
    }
}

export const sbomJava = sbomPluginFor('sbom-java', 'maven', java)
export const sbomNpm = sbomPluginFor('sbom-npm', 'npm', javascript)
export const sbomRuby = sbomPluginFor('sbom-ruby', 'gem', ruby)
export const sbomPython = sbomPluginFor('sbom-python', 'pypi', python)
export const sbomPhp = sbomPluginFor('sbom-php', 'composer', php)
export const sbomDotnet = sbomPluginFor('sbom-dotnet', 'nuget', dotnet)

export const sbomPlugins: Plugin[] = [
    sbomJava,
    sbomNpm,
    sbomRuby,
    sbomPython,
    sbomPhp,
    sbomDotnet,
]

/** Exposed for tests, which need each parse to start from a clean slate. */
export function clearSbomCache(): void {
    cache.clear()
}
