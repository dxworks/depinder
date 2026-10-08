import fs from 'fs'
import path from 'path'
import {minimatch} from 'minimatch'
import {DepinderDependency, DepinderProject} from '../../extension-points/extract'
import {Plugin} from '../../extension-points/plugin'
import {Vulnerability, VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import {parseCycloneDxFile} from './cyclonedx'
import {scanSbomFileOnce} from './local-scan'
import {githubScanSbomFileOnce} from '../../vuln-sources/github/scan'
import {mergeVulnerabilityIndexes} from '../../vuln-sources/merge'
import {vulnSources} from '../../vuln-sources/selection'
import {dotnetChecker, goChecker, javaChecker, npmChecker, phpChecker, pythonChecker, rubyChecker, rustChecker} from '../vulnerability-checkers'

/**
 * CycloneDX SBOM plugins.
 *
 * A single SBOM spans several ecosystems at once (on Apache Zeppelin: maven, npm, gem, pypi), but a
 * depinder Plugin has exactly one purl type and one advisory ecosystem. So rather than one `sbom`
 * plugin, we register one per ecosystem: each reads the same SBOM files, filters to its own purl
 * type, and is enriched through the registry fallback and its vulnerability checker. CycloneDX
 * SBOMs are depinder's only input.
 */

/**
 * Every JSON file is a candidate; `isSbomFile` then reads the head of the file and keeps the ones
 * that declare `"bomFormat": "CycloneDX"`. `*.cdx.json` (Syft and Trivy alike) is kept by name alone.
 */
const SBOM_GLOBS = ['*.json']
const SBOM_NAME_GLOBS = ['*.cdx.json']
const SBOM_HEAD_BYTES = 4096
const BOM_FORMAT = /"bomFormat"\s*:\s*"CycloneDX"/

/** Parsing the same file for several ecosystems is common — memoise it. */
const cache = new Map<string, DepinderProject[]>()

function projectsOf(sbomFile: string, purlType: string): DepinderProject[] {
    const key = `${purlType}:${sbomFile}`
    const hit = cache.get(key)
    if (hit) return hit

    const projects = parseCycloneDxFile(sbomFile, purlType)
    cache.set(key, projects)
    return projects
}

/**
 * When set, `parseSbomProjects` leaves `dep.vulnerabilities` and `exactVersionVulnerabilities`
 * alone, and analyse.ts attaches them once the vulnerability server has answered, or once the
 * local scan it fell back to has. Off by default: parsing then scans locally.
 */
let findingsDeferred = false

export function deferSbomFindings(deferred: boolean): void {
    findingsDeferred = deferred
}

/** The projects of one SBOM for one purl type: the very objects `parseSbomProjects` hands out. */
export function sbomProjectsOf(sbomFile: string, purlType: string): DepinderProject[] {
    return projectsOf(path.resolve(sbomFile), purlType)
}

/**
 * The projects of one SBOM for one purl type, ready for enrichment: with the local scan's findings
 * attached (once per file per process), unless the run has deferred them to the vulnerability
 * server (`deferSbomFindings`).
 */
export async function parseSbomProjects(sbomFile: string, purlType: string): Promise<DepinderProject[]> {
    const absolute = path.resolve(sbomFile)
    const projects = projectsOf(absolute, purlType)
    if (!findingsDeferred) {
        for (const project of projects) await attachLocalFindings(absolute, project)
    }
    return projects
}

/**
 * The local scan's findings on one project of `sbomFile`: Trivy and Grype on this machine, plus
 * GitHub's advisory cache when selected.
 *
 * Which sources run is the run's `--vuln-source` selection: Trivy and Grype shell out to a local
 * binary, `github` matches against the downloaded advisory cache. All of them matched the exact
 * version recorded in the SBOM, so these findings are final: `exactVersionVulnerabilities` is
 * what tells analyse.ts not to range-filter them. When no source produced anything the flag stays
 * unset and the per-package GHSA GraphQL path runs instead. `projectsOf` memoises projects by
 * reference, so the flag sticks for the process — correct here, since it is a property of the
 * file, not of the caller.
 */
export async function attachLocalFindings(sbomFile: string, project: DepinderProject): Promise<void> {
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
}

/**
 * The vulnerability server's findings on one project of `sbomFile`: `serverFindings(dep)` is what
 * the server answered for the dependency's purl, `[]` when it was clean or not scannable. GitHub's
 * advisory cache, when selected, is matched locally and merged in exactly as it is into a local
 * scan, keyed the same way. An answer from the server is a scan that ran, so the flag is set.
 */
export function attachServerFindings(
    sbomFile: string, project: DepinderProject, serverFindings: (dep: DepinderDependency) => Vulnerability[],
): void {
    const github = vulnSources().github ? githubScanSbomFileOnce(sbomFile) : undefined
    for (const dep of Object.values(project.dependencies)) {
        const findings = [...serverFindings(dep)]
        const advisories = github?.index.get(dep.id)
        if (advisories?.length) {
            mergeVulnerabilityIndexes(new Map([[dep.id, findings]]), new Map([[dep.id, advisories]]))
        }
        dep.vulnerabilities = findings
    }
    project.exactVersionVulnerabilities = true
}

/** One ecosystem of the SBOM route: which purl type it filters on and where it enriches from. */
interface SbomEcosystem {
    name: string
    purlType: string
    /**
     * The cache namespace, `${ecosystem}:${name}`. These are the names the ecosystem-specific
     * manifest plugins cached under before SBOMs became the only input: changing one would
     * invalidate every cached library of that ecosystem.
     */
    ecosystem: string
    /** Extra CLI names for `-p`, after `sbom-<purlType>`: the old plugin names still select it. */
    aliases: string[]
    checker?: VulnerabilityChecker
}

function sbomPluginFor({name, purlType, ecosystem, aliases, checker}: SbomEcosystem): Plugin {
    return {
        name,
        aliases: [`sbom-${purlType}`, ...aliases],
        ecosystem,
        purlType,
        checker,
    }
}

/**
 * The ecosystems the SBOM route covers. This is the single place the (plugin name, purl type,
 * checker) correspondence is written down — every lookup below reads it rather than restating it.
 */
const SBOM_ECOSYSTEMS: readonly SbomEcosystem[] = [
    {name: 'sbom-java', purlType: 'maven', ecosystem: 'java', aliases: ['java', 'maven', 'gradle'], checker: javaChecker},
    {name: 'sbom-npm', purlType: 'npm', ecosystem: 'npm', aliases: ['npm', 'js', 'javascript', 'node', 'nodejs', 'yarn'], checker: npmChecker},
    {name: 'sbom-ruby', purlType: 'gem', ecosystem: 'ruby', aliases: ['ruby', 'gem'], checker: rubyChecker},
    {name: 'sbom-python', purlType: 'pypi', ecosystem: 'python', aliases: ['python', 'pip', 'pipenv', 'poetry'], checker: pythonChecker},
    {name: 'sbom-php', purlType: 'composer', ecosystem: 'php', aliases: ['php', 'composer'], checker: phpChecker},
    {name: 'sbom-dotnet', purlType: 'nuget', ecosystem: 'dotnet', aliases: ['dotnet', '.net', 'c#', 'csharp', 'nuget'], checker: dotnetChecker},
    {name: 'sbom-go', purlType: 'golang', ecosystem: 'go', aliases: [], checker: goChecker},
    {name: 'sbom-rust', purlType: 'cargo', ecosystem: 'rust', aliases: [], checker: rustChecker},
]

export const sbomPlugins: Plugin[] = SBOM_ECOSYSTEMS.map(sbomPluginFor)

export const [sbomJava, sbomNpm, sbomRuby, sbomPython, sbomPhp, sbomDotnet, sbomGo, sbomRust] = sbomPlugins

const sbomByContent = new Map<string, boolean>()

/**
 * Whether a file is a CycloneDX SBOM. A `*.cdx.json` is one by name; any other `*.json` is one
 * when its first bytes declare a CycloneDX `bomFormat` — so a SBOM saved as `bom.json` is found,
 * while `package.json` and lockfiles cost one short read and are ignored.
 */
export function isSbomFile(file: string): boolean {
    if (SBOM_NAME_GLOBS.some(glob => minimatch(file, glob, {matchBase: true}))) return true
    if (!SBOM_GLOBS.some(glob => minimatch(file, glob, {matchBase: true}))) return false
    const hit = sbomByContent.get(file)
    if (hit !== undefined) return hit
    const result = declaresCycloneDx(file)
    sbomByContent.set(file, result)
    return result
}

function declaresCycloneDx(file: string): boolean {
    let fd: number | undefined
    try {
        fd = fs.openSync(file, 'r')
        const buffer = Buffer.alloc(SBOM_HEAD_BYTES)
        const read = fs.readSync(fd, buffer, 0, SBOM_HEAD_BYTES, 0)
        return BOM_FORMAT.test(buffer.toString('utf8', 0, read))
    } catch {
        return false
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }
}

/** Exposed for tests, which rewrite a file under the same name. */
export function clearSbomFileCache(): void {
    sbomByContent.clear()
}

/**
 * The SBOM files at least one of the selected plugins will actually parse, in the order the
 * analysis first reaches them: plugin by plugin, file by file. A file whose ecosystems none of
 * them covers yields no project and is never scanned by the parse either, so scanning it up
 * front would only add a file to the provenance record.
 */
export function sbomFilesToParse(plugins: Plugin[], sbomFiles: string[]): string[] {
    const ordered = new Set<string>()
    for (const plugin of plugins) {
        for (const file of sbomFiles) {
            if (sbomProjectsOf(file, plugin.purlType).length > 0) ordered.add(file)
        }
    }
    return [...ordered]
}

/**
 * The SBOM plugins that can say anything about these purl types.
 *
 * `analyse` selects the plugins for an SBOM source from the SBOMs it found, so that a user pointing
 * at a folder of SBOMs never has to work out which `sbom-*` plugins their ecosystems correspond to.
 */
export function sbomPluginsForPurlTypes(purlTypes: Iterable<string>): Plugin[] {
    const wanted = new Set([...purlTypes].map(it => it.trim().toLowerCase()))
    return sbomPlugins.filter(it => wanted.has(it.purlType))
}

/** Exposed for tests, which need each parse to start from a clean slate. */
export function clearSbomCache(): void {
    cache.clear()
}
