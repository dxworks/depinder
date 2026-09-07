import path from 'path'
import {minimatch} from 'minimatch'
import {DependencyFileContext, DepinderProject, Extractor, Parser} from '../../extension-points/extract'
import {ecosystemOf, Plugin} from '../../extension-points/plugin'
import {Registrar} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import {parseCycloneDxFile} from './cyclonedx'
import {scanSbomFileOnce} from './local-scan'
import {githubScanSbomFileOnce} from '../../vuln-sources/github/scan'
import {mergeVulnerabilityIndexes} from '../../vuln-sources/merge'
import {vulnSources} from '../../vuln-sources/selection'
import {java} from '../java'
import {javascript} from '../javascript'
import {ruby} from '../ruby'
import {python} from '../python'
import {php} from '../php'
import {dotnet} from '../dotnet'
import {goChecker, goRegistrar} from '../go/registrar'
import {cratesRegistrar, rustChecker} from '../rust/registrar'

/**
 * CycloneDX SBOM plugins.
 *
 * A single SBOM spans several ecosystems at once (on Apache Zeppelin: maven, npm, gem, pypi), but a
 * depinder Plugin has exactly one registrar and one advisory ecosystem. So rather than one `sbom`
 * plugin, we register one per ecosystem: each reads the same SBOM files, filters to its own purl
 * type, and reuses the registrar and vulnerability checker of the corresponding native plugin. No
 * registry code is duplicated. Go and Rust have no native plugin to borrow from — depinder never
 * parsed go.sum or Cargo.lock — so their registrars exist for the SBOM route alone.
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

            // Vulnerability scan of the SBOM, once per file per process. Which sources run is
            // the run's `--vuln-source` selection: Trivy and Grype shell out to a local binary,
            // `github` matches against the downloaded advisory cache. All of them matched the
            // exact version recorded in the SBOM, so these findings are final:
            // `exactVersionVulnerabilities` is what tells analyse.ts not to range-filter them.
            // When no source produced anything the flag stays unset and the per-package GHSA
            // GraphQL path runs exactly as it does for a native plugin. `projectsOf` memoises
            // projects by reference, so the flag sticks for the process — correct here, since it
            // is a property of the file, not of the caller.
            const scan = await scanSbomFileOnce(sbomFile)
            const github = vulnSources().github
                ? githubScanSbomFileOnce(sbomFile)
                : {available: false, index: new Map()}
            const findings = mergeVulnerabilityIndexes(new Map(scan.index), github.index)

            if (scan.available || github.available) {
                for (const dep of Object.values(project.dependencies)) {
                    dep.vulnerabilities = findings.get(dep.id) ?? []
                }
                project.exactVersionVulnerabilities = true
            }
            return project
        },
    }
}

/** One ecosystem of the SBOM route: which purl type it filters on and where it enriches from. */
interface SbomEcosystem {
    name: string
    purlType: string
    /**
     * The cache namespace. The native plugin's own, where one exists: same registrar, same library
     * names, so the enrichment cache must not be fetched twice.
     */
    ecosystem: string
    registrar: Registrar
    checker?: VulnerabilityChecker
}

/** An ecosystem that borrows registrar, checker and cache namespace from a native plugin. */
function borrowing(name: string, purlType: string, source: Plugin): SbomEcosystem {
    return {name, purlType, ecosystem: ecosystemOf(source), registrar: source.registrar, checker: source.checker}
}

function sbomPluginFor({name, purlType, ecosystem, registrar, checker}: SbomEcosystem): Plugin {
    return {
        name,
        aliases: [`sbom-${purlType}`],
        ecosystem,
        extractor: createExtractor(purlType),
        parser: createParser(purlType),
        registrar,
        checker,
    }
}

/**
 * The ecosystems the SBOM route covers. This is the single place the (plugin name, purl type,
 * registrar) correspondence is written down — every lookup below reads it rather than restating it.
 */
const SBOM_ECOSYSTEMS: readonly SbomEcosystem[] = [
    borrowing('sbom-java', 'maven', java),
    borrowing('sbom-npm', 'npm', javascript),
    borrowing('sbom-ruby', 'gem', ruby),
    borrowing('sbom-python', 'pypi', python),
    borrowing('sbom-php', 'composer', php),
    borrowing('sbom-dotnet', 'nuget', dotnet),
    {name: 'sbom-go', purlType: 'golang', ecosystem: 'go', registrar: goRegistrar, checker: goChecker},
    {name: 'sbom-rust', purlType: 'cargo', ecosystem: 'rust', registrar: cratesRegistrar, checker: rustChecker},
]

export const sbomPlugins: Plugin[] = SBOM_ECOSYSTEMS.map(sbomPluginFor)

export const [sbomJava, sbomNpm, sbomRuby, sbomPython, sbomPhp, sbomDotnet, sbomGo, sbomRust] = sbomPlugins

/**
 * The SBOM files a given plugin selection would scan.
 *
 * The parser is the only layer that holds an SBOM path, but the scanner preflight has to run once
 * and up front, before any parsing — so analyse.ts needs to know whether the SBOM route is live
 * from the file list alone. Same globs the extractors use, so the two cannot drift apart.
 */
export function sbomFilesFor(plugins: Plugin[], files: string[]): string[] {
    if (!plugins.some(plugin => sbomPlugins.includes(plugin))) return []
    return files.filter(file => SBOM_GLOBS.some(glob => minimatch(file, glob, {matchBase: true})))
}

/**
 * The SBOM files at least one of the selected sbom plugins will actually parse, in the order the
 * parsers would first reach them: plugin by plugin, file by file. A file whose ecosystems none of
 * them covers yields no project and is never scanned by the parser either, so scanning it up
 * front would only add a file to the provenance record.
 */
export function sbomFilesToParse(plugins: Plugin[], files: string[]): string[] {
    const candidates = sbomFilesFor(plugins, files)
    const ordered = new Set<string>()
    for (const plugin of plugins.filter(it => sbomPlugins.includes(it))) {
        for (const file of candidates) {
            if (plugin.extractor.createContexts([file]).length > 0) ordered.add(file)
        }
    }
    return [...ordered]
}

/**
 * The purl type an SBOM plugin filters on — `sbom-npm` -> `npm`. The alias is where that type is
 * already recorded, so reading it back beats a second table that could drift out of step. Returns
 * undefined for a native plugin, which has no single purl type.
 */
export function purlTypeOfPlugin(plugin: Plugin): string | undefined {
    if (!sbomPlugins.includes(plugin)) return undefined
    return plugin.aliases?.find(it => it.startsWith('sbom-'))?.slice('sbom-'.length)
}

/**
 * The purl type a NATIVE plugin's components carry — `java` -> `maven`. The SBOM ecosystem table
 * already pairs the two, so reading it back beats a second table that could drift out of step.
 */
export function purlTypeOfEcosystem(ecosystem: string): string | undefined {
    return SBOM_ECOSYSTEMS.find(it => it.ecosystem === ecosystem)?.purlType
}

/**
 * The SBOM plugins that can say anything about these purl types.
 *
 * `export-blackduck` selects its own plugins from the SBOMs it was given, so that a user pointing
 * at a folder of SBOMs never has to work out which `sbom-*` plugins their ecosystems correspond to.
 */
export function sbomPluginsForPurlTypes(purlTypes: Iterable<string>): Plugin[] {
    const wanted = new Set([...purlTypes].map(it => it.trim().toLowerCase()))
    return sbomPlugins.filter(it => {
        const purlType = purlTypeOfPlugin(it)
        return !!purlType && wanted.has(purlType)
    })
}

/** Exposed for tests, which need each parse to start from a clean slate. */
export function clearSbomCache(): void {
    cache.clear()
}
