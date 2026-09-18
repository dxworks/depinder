import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {purlTypeOfEcosystem, purlTypeOfPlugin, sbomFilesToParse, sbomPlugins, sbomPluginsForPurlTypes} from '../plugins/sbom'
import {SbomDescription} from '../plugins/sbom/describe'
import {
    preflightScanners,
    ScannerPreflight,
    scanSbomFileOnce,
    scannerPreflightMessages,
    scannerSummaryLine,
    writeScanProvenance,
} from '../plugins/sbom/local-scan'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {LibraryInfo} from '../extension-points/registrar'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Range} from 'semver'
import _ from 'lodash'
import spdxCorrect from 'spdx-correct'
import moment from 'moment'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {Cache, noCache} from '../cache/cache'
import {getMongoDockerContainerStatus} from './cache'
import {sqliteCache} from '../cache/sqlite-cache'
import {MISS_TTL_HOURS, missCache, MissCache, noMissCache} from '../cache/misses'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {MultiBar, Presets} from 'cli-progress'
import {walkDir} from '../utils/utils'
import {blacklistedGlobs} from '../utils/blacklist'
import { minimatch } from 'minimatch'
import {mongoCache} from '../cache/mongo-cache'
import {
    DEFAULT_VULN_SOURCE,
    describeVulnSources,
    parseVulnSources,
    setVulnSources,
} from '../vuln-sources/selection'
import {ecosystemsInSboms} from '../vuln-sources/github/scan'
import {refreshEcosystems} from '../vuln-sources/github/download'
import {DEFAULT_MAX_AGE_HOURS} from '../vuln-sources/github/cache'
import {DEFAULT_TOKEN_FILE} from '../vuln-sources/github/tokens'
import {AnalysedEcosystem} from '../blackduck/model'
import {writeBlackDuckForSource} from '../blackduck/run'
import {classifyInputs, inputFolderOf, InputSources, NATIVE_SOURCE} from './sources'
import {csvRow} from '../utils/csv'
import {log} from '../utils/logging'
import {count, enableProfile, logProfile, startPhase, timePhase} from '../utils/profile'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const licenseIds = require('spdx-license-ids/')

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100

export interface AnalyseOptions {
    plugins?: string[]
    results: string
    refresh: boolean
    /** Comma-separated: trivy, grype, github, all. Defaults to today's behaviour, trivy+grype. */
    vulnSource?: string
    githubTokenFile?: string
    /** Hours before a cached ecosystem's advisories are re-downloaded. */
    githubMaxAge?: string
    /** Print per-phase wall-clock, cache and HTTP request counts at the end of the run. */
    profile?: boolean
    /** SBOM sources: the `Project path` value and the head of every dependency path. */
    projectName?: string
    /** SBOM sources: the scanned repositories, one per SBOM repo name, for Black Duck's `Path` prefix. */
    target?: string
}

/** A factory rather than a single instance, so tests can parse arguments from a clean slate. */
export function createAnalyseCommand(): Command {
    return new Command()
        .name('analyse')
        .argument('[folders...]', 'Folders to walk: native project folders, SBOM folders, or both')
        // .argument('[depext-files...]', 'A list of files to parse for dependency information')
        // Both value-taking options need a <value> placeholder: without one Commander registers
        // them as booleans, so `-r out` set `{R: true}` and left `out` to be walked as another
        // folder, and `--plugins` never reached getPluginsFromNames.
        .option('-r, --results <folder>', 'The results folder', 'results')
        .option('--refresh', 'Refresh the cache', false)
        .option('-p, --plugins [plugins...]', 'A list of plugins')
        .option('--project-name <name>',
            'SBOM sources: the name to write in the Project path column and at the head of every dependency path')
        .option('--target <folder>',
            'SBOM sources: the folder holding the scanned repositories, one per SBOM name; their manifests give '
            + 'Path its Black Duck project prefix and drop the repository\'s own code from the chain')
        .option('--vuln-source <sources>',
            'Vulnerability sources for the SBOM route: a comma-separated list of trivy, grype, github, all',
            DEFAULT_VULN_SOURCE)
        .option('--github-token-file <file>',
            'Dotenv-style file holding GH_TOKEN_1, GH_TOKEN_2, ... for --vuln-source github',
            DEFAULT_TOKEN_FILE)
        .option('--github-max-age <hours>',
            'Re-download a cached ecosystem\'s GitHub advisories when they are older than this',
            String(DEFAULT_MAX_AGE_HOURS))
        .option('--profile', 'Print a phase timing and request count summary at the end', false)
        .action(analyseFiles)
}

export const analyseCommand = createAnalyseCommand()


function extractLicenses(dep: DepinderDependency) {
    return dep.libraryInfo?.licenses?.map(it => {
        if (typeof it === 'string') return it.substring(0, 100); else return JSON.stringify(it)
    })
}

export function convertDepToRow(proj: DepinderProject, dep: DepinderDependency): string {
    const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
    const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim())
    const latestVersionMoment = moment(latestVersion?.timestamp)
    const currentVersionMoment = moment(currentVersion?.timestamp)
    const now = moment()

    const dateFormat = 'MMM YYYY'
    const vulnerabilities = dep.vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n')
    const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))
    return csvRow([
        proj.path, proj.name, dep.name, dep.version, latestVersion?.version,
        currentVersionMoment?.format(dateFormat), latestVersionMoment?.format(dateFormat),
        latestVersionMoment?.diff(currentVersionMoment, 'months'),
        now?.diff(currentVersionMoment, 'months'), now?.diff(latestVersionMoment, 'months'),
        dep.vulnerabilities?.length, vulnerabilities, directDep, dep.type, extractLicenses(dep),
    ])
}

async function extractProjects(plugin: Plugin, files: string[]) {
    const projects = [] as DepinderProject[]

    for (const context of plugin.extractor.createContexts(files)) {
        log.info(`Parsing dependency tree information for ${JSON.stringify(context)}`)
        try {
            if (!plugin.parser) {
                log.info(`Plugin ${plugin.name} does not have a parser!`)
                continue
            }
            const proj: DepinderProject = await plugin.parser.parseDependencyTree(context)
            log.info(`Done parsing dependency tree information for ${JSON.stringify(context)}`)
            projects.push(proj)
        } catch (e: any) {
            log.warn(`Exception parsing dependency tree information for ${JSON.stringify(context)}`)
            log.error(e)
        }
    }
    return projects
}

/**
 * `LibraryInfo.vulnerabilities` is library-level advisory data covering all versions, so it must be
 * narrowed to the version actually in use. An unparseable range is treated as "does not apply".
 */
export function advisoriesMatchingVersion(lib: LibraryInfo, version: string): Vulnerability[] {
    return (lib.vulnerabilities ?? []).filter((it: Vulnerability) => {
        try {
            return new Range(it.vulnerableRange?.replaceAll(',', ' ') ?? '').test(version)
        } catch (e: any) {
            return false
        }
    })
}

/**
 * Two vulnerability shapes reach a dependency, and only one of them may be range-filtered:
 *  - a parser that scanned the artefact already matched this exact version -> take verbatim
 *  - otherwise, library-level advisories from the registrar -> narrow to this version
 */
export function resolveVulnerabilities(project: DepinderProject, dep: DepinderDependency, lib: LibraryInfo): Vulnerability[] {
    if (project.exactVersionVulnerabilities) return dep.vulnerabilities ?? []
    return advisoriesMatchingVersion(lib, dep.version)
}

/**
 * The license a library is grouped under. Library-level `licenses` is the field every registrar
 * fills (and the one libs.csv reports); the per-version list is optional and left empty by some —
 * the maven registrar sets `licenses: []` on every version — so grouping on it alone reported
 * everything as unknown. Fall back to the per-version list for registrars that only fill that.
 */
function licenseOf(lib: LibraryInfo): string {
    const license = lib.licenses?.find(it => typeof it === 'string' && it)
        ?? lib.versions.flatMap(it => it.licenses).find(it => typeof it === 'string' && it)
    if (!license || typeof license !== 'string')
        return 'unknown'
    if (!licenseIds.includes(license))
        return spdxCorrect(license) || 'unknown'
    return license
}

function chooseCacheOption(): Cache {

    if (getMongoDockerContainerStatus() != 'running') {
        log.info('Mongo cache is not running, using the local SQLite cache')
        return sqliteCache
    }
    log.info('Mongo cache is up and running, using Mongo cache')
    return mongoCache
}

async function cacheHit(cache: Cache, cacheKey: string, dep: DepinderDependency, refresh: boolean, refreshedLibs: any[]) {
    if (refresh && !refreshedLibs.includes(dep.name)) {
        return false
    }
    return cache.has(cacheKey)
}

const REGISTRY_CONCURRENCY = 8
/**
 * How often the caches are flushed mid-run, so a crash loses at most this much work. Time-based
 * rather than every N lookups because a flush serialises the whole positive cache (tens of MB),
 * and doing that every 50 lookups on a cold run cost more than the lookups it protected.
 */
const CACHE_CHECKPOINT_MS = 60_000
const RATE_LIMIT_RETRY_DELAYS_MS = [2000, 4000, 8000]

function isRateLimit(e: any): boolean {
    return e?.response?.status === 429 || e?.status === 429
}

async function retrieveWithRetry(plugin: Plugin, name: string): Promise<LibraryInfo> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await plugin.registrar.retrieve(name)
        } catch (e: any) {
            if (!isRateLimit(e) || attempt >= RATE_LIMIT_RETRY_DELAYS_MS.length) throw e
            const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt]
            log.warn(`Rate limited (429) retrieving ${name}, retrying in ${delay}ms`)
            await new Promise(resolve => setTimeout(resolve, delay))
        }
    }
}

/**
 * What one plugin's pass produced: the purl type its components carry, and the projects it
 * enriched. The Black Duck-shaped files are built out of this, which is what keeps the SBOM
 * sources from growing a second copy of the analysis.
 */
export type AnalysisResult = AnalysedEcosystem

/**
 * One results subfolder's worth of work: the plugins that run, the files their extractors see,
 * and — for an SBOM source — the SBOMs themselves, in walk order.
 */
export interface PlannedRun {
    /** `trivy`, `syft` or `depinder`; also the subfolder under the results folder. */
    source: string
    /** Absolute: `<results>/<source>`. */
    folder: string
    /** The input folder the source's files came from — the project-name fallback. */
    inputFolder: string
    plugins: Plugin[]
    files: string[]
    sboms?: SbomDescription[]
}

/** The files one plugin's extractor takes from a pool. */
export function filesForPlugin(plugin: Plugin, files: string[]): string[] {
    return files
        .filter(it => plugin.extractor.filter ? plugin.extractor.filter(it) : true)
        .filter(it => plugin.extractor.files.some(pattern => minimatch(it, pattern, {matchBase: true})))
}

/**
 * Which sources get a run, and with which plugins.
 *
 * Native: every selected native plugin, into `depinder/`, as long as at least one of them has a
 * file to read — a plugin with no files still writes its three empty CSVs, as it always has.
 * SBOM: the `sbom-*` plugins the source's purl types call for (an explicit `-p` narrows to the
 * sbom plugins it names), into `<producer>/`.
 */
export function planRuns(sources: InputSources, selected: Plugin[], options: AnalyseOptions, resultRoot: string, folders: string[]): PlannedRun[] {
    const runs: PlannedRun[] = []
    const explicit = !!options.plugins?.length
    for (const source of sources.sbom) {
        const purlTypes = new Set(source.sboms.flatMap(it => [...it.purlTypes]))
        const plugins = explicit
            ? selected.filter(it => sbomPlugins.includes(it))
            : sbomPluginsForPurlTypes(purlTypes)
        if (plugins.length === 0) {
            if (explicit) log.info(`${source.name}: skipped, --plugins names no sbom-* plugin`)
            else log.warn(`${source.name}: no sbom-* plugin covers the ecosystems in these SBOMs`
                + ` (${[...purlTypes].sort().join(', ')}); nothing to analyse`)
            continue
        }
        log.info(`${source.name}: ${source.sboms.length} SBOM(s), ecosystems ${[...purlTypes].sort().join(', ')}`
            + ` -> plugins ${plugins.map(it => it.name).join(', ')}`)
        runs.push({
            source: source.name,
            folder: path.join(resultRoot, source.name),
            inputFolder: inputFolderOf(source, folders),
            plugins,
            files: source.sboms.map(it => it.file),
            sboms: source.sboms,
        })
    }
    const nativePlugins = selected.filter(it => !sbomPlugins.includes(it))
    if (nativePlugins.some(it => filesForPlugin(it, sources.native).length > 0)) {
        runs.push({
            source: NATIVE_SOURCE,
            folder: path.join(resultRoot, NATIVE_SOURCE),
            inputFolder: folders[0] ?? '.',
            plugins: nativePlugins,
            files: sources.native,
        })
    }
    return runs
}

interface SbomPreparation {
    preflight?: ScannerPreflight
    hasGithubToken: boolean
}

/**
 * Everything the SBOM route does once per process, before any parsing: the scanner preflight,
 * the GitHub advisory refresh and the up-front scan of every SBOM any run will parse.
 */
async function prepareSbomScans(runs: PlannedRun[], options: AnalyseOptions): Promise<SbomPreparation | undefined> {
    const sbomRuns = runs.filter(it => it.sboms)
    if (sbomRuns.length === 0) return undefined
    const sbomFiles = sbomRuns.flatMap(it => it.files)
    const hasGithubToken = !!process.env.GH_TOKEN
    const sources = parseVulnSources(options.vulnSource ?? DEFAULT_VULN_SOURCE)
    setVulnSources(sources)
    log.info(`Vulnerability sources: ${describeVulnSources(sources)}`)

    // Scanner preflight, before any parsing: the SBOM parsers shell out to Trivy and Grype, and a
    // missing binary used to surface only as a mid-run warning per file — leaving the user with a
    // completed run, empty vulnerability columns and nothing that said so. Run once, say it up
    // front, and never abort: a run without scanners is degraded, not invalid.
    const runsLocalScanners = sources.trivy || sources.grype
    const preflight = runsLocalScanners ? await timePhase('preflight', () => preflightScanners()) : undefined
    if (preflight) {
        for (const message of scannerPreflightMessages(preflight, hasGithubToken)) log[message.level](message.text)
    }

    // The GitHub cache is refreshed before any parsing, and only for the ecosystems these SBOMs
    // actually contain — a Ruby project never downloads npm's 7,000 advisories. A refresh failure
    // is a warning: whatever is already cached still matches.
    if (sources.github) {
        const ecosystems = ecosystemsInSboms(sbomFiles)
        log.info(`GitHub advisory ecosystems in these SBOMs: ${ecosystems.join(', ') || 'none'}`)
        try {
            const report = await timePhase('github-advisories:refresh', () =>
                refreshEcosystems(ecosystems, Number(options.githubMaxAge ?? DEFAULT_MAX_AGE_HOURS), {
                    tokenFile: options.githubTokenFile,
                }))
            if (!report) log.info('GitHub advisory cache is up to date; nothing to download')
        } catch (e: any) {
            log.warn(`GitHub advisory refresh skipped: ${e?.message ?? e}`)
        }
    }

    // Trivy and Grype run on every SBOM a plugin will parse, all at once and up front. Each file
    // is scanned exactly once either way — the parser memoises — but the parser reaches the files
    // one project at a time, which serialised a dozen one-to-two-second Grype runs.
    if (preflight) {
        await timePhase('scan:prescan', () =>
            Promise.all(sbomRuns.flatMap(it => sbomFilesToParse(it.plugins, it.files)).map(file => scanSbomFileOnce(file))))
    }
    return {preflight, hasGithubToken}
}

/** The process-wide cache handle: opened once, checkpointed mid-run, closed once at the end. */
export interface CacheSession {
    cache: Cache
    misses: MissCache
    checkpointIfDue: () => Promise<void>
    /** The teardown write: flushes anything still pending and releases the cache's resources. */
    close: () => Promise<void>
}

async function openCacheSession(useCache: boolean): Promise<CacheSession> {
    const cache: Cache = useCache ? chooseCacheOption() : noCache
    const misses: MissCache = useCache ? missCache : noMissCache
    await timePhase('cache:load', async () => {
        await cache.load()
        misses.load()
    })
    // Mid-run durability only: `cache.write()` is also the teardown step (the Mongo cache closes
    // its connection there), so a checkpoint that called it would leave every later lookup in the
    // run talking to a disconnected client — and those failures are swallowed per dependency, so
    // the run would still finish and write CSVs with the enrichment silently missing.
    const checkpoint = () => timePhase('cache:write', async () => {
        await cache.flush?.()
        misses.write()
    })
    let lastCheckpoint = Date.now()
    const checkpointIfDue = async () => {
        if (Date.now() - lastCheckpoint < CACHE_CHECKPOINT_MS) return
        lastCheckpoint = Date.now()
        await checkpoint()
    }
    const close = () => timePhase('cache:write', async () => {
        await cache.write()
        misses.write()
    })
    return {cache, misses, checkpointIfDue, close}
}

/**
 * `depinder analyse <folders...>`: one results subfolder per source found under the folders.
 *
 * The files decide, not the folders: every walked file is classified by content (`sources.ts`),
 * so a folder of Trivy SBOMs, one of Syft SBOMs and a checked-out repository can be given in one
 * invocation, or in three. Each SBOM source gets the `sbom-*` plugin CSVs, the scan provenance
 * and the Black Duck-shaped files under `<results>/<producer>/`; the native plugins write their
 * CSVs under `<results>/depinder/`. A subfolder exists only when its source had input.
 */
export async function analyseFiles(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    if (options.profile) enableProfile()
    const resultRoot = path.resolve(process.cwd(), options.results || 'results')
    const allFiles = folders.flatMap(it => walkDir(it))
    const selected = getPluginsFromNames(options.plugins)
    const runs = planRuns(classifyInputs(allFiles), selected, options, resultRoot, folders)
    if (runs.length === 0) {
        log.warn(`Nothing to analyse under ${folders.join(', ') || '.'}`)
        return
    }

    const prep = await prepareSbomScans(runs, options)
    const session = await openCacheSession(useCache)
    try {
        for (const run of runs) {
            const analysed = await runAnalysis(run.files, run.plugins, run.folder, options, session)
            if (run.sboms) {
                // Only when the local scanners ran: the file records their versions and DB builds,
                // which is what makes a vulnerability count reproducible.
                if (prep?.preflight) {
                    try {
                        const provenanceFile = await writeScanProvenance(run.folder, prep.hasGithubToken, run.sboms)
                        log.info(`Scan provenance written to ${provenanceFile}`)
                    } catch (e: any) {
                        log.warn(`Could not write scan provenance: ${e?.message ?? e}`)
                    }
                }
                writeBlackDuckForSource(run.sboms, analysed, run.folder, run.inputFolder, options)
            }
            log.info(`Results for ${run.source} are written to ${run.folder}`)
        }
    } finally {
        await session.close()
    }

    if (prep?.preflight) {
        // Repeated here because the preflight banner is thousands of log lines back by now, and
        // because a CSV is only readable next to the matcher and DB build that produced it.
        const summary = scannerSummaryLine(prep.preflight, prep.hasGithubToken)
        log[summary.level](summary.text)
    }
    log.info('Done')
    logProfile()
}

/**
 * Runs `plugins` over `files` and writes each plugin's three CSVs into `resultFolder`. The
 * enrichment is shared by every source: this is the one place a dependency is looked up.
 */
export async function runAnalysis(files: string[], plugins: Plugin[], resultFolder: string, options: AnalyseOptions, session: CacheSession): Promise<AnalysisResult[]> {
    if (!fs.existsSync(resultFolder)) {
        fs.mkdirSync(resultFolder, {recursive: true})
        log.info(`Creating results dir ${resultFolder}`)
    }
    const progress = new MultiBar({}, Presets.shades_grey)

    // The plugins run side by side. Each talks to its own registry, so six at once put no more
    // than REGISTRY_CONCURRENCY requests on any one of them, and a registry that stalls — Maven
    // Central's search API, for one — no longer holds the others up.
    const results = await Promise.all(plugins.map(async (plugin): Promise<AnalysisResult | undefined> => {
        log.info(`Plugin ${plugin.name} starting`)

        const refreshedLibs = [] as string[]
        const inFlight = new Map<string, Promise<LibraryInfo>>()

        const projects: DepinderProject[] = await timePhase(`parse:${plugin.name}`, () =>
            extractProjects(plugin, filesForPlugin(plugin, files)))

        const projectsBar = progress.create(projects.length, 0, {name: 'Projects', state: 'Analysing'})


        const enrich = startPhase(`enrich:${plugin.name}`)
        for (const project of projects) {
            log.info(`Plugin ${plugin.name} analyzing project ${project.name}@${project.version}`)
            const dependencies = Object.values(project.dependencies)
            const filteredDependencies = dependencies.filter(it => !blacklistedGlobs.some(glob => minimatch(it.name, glob)))
            const depProgressBar = progress.create(filteredDependencies.length, 0, {
                name: 'Deps',
                state: 'Analysing deps',
            })
            let depsWithInfo = 0

            const processDep = async (dep: DepinderDependency) => {
                try {
                    let lib
                    // Keyed by ecosystem, not plugin name: `java` and `sbom-java` share a
                    // registrar, so they must share cache entries rather than fetch each library
                    // twice. `update.ts` reconstructs library names from this same prefix.
                    const cacheKey = `${ecosystemOf(plugin)}:${dep.name}`
                    if (await cacheHit(session.cache, cacheKey, dep, options.refresh, refreshedLibs)) {
                        count('cache:hit')
                        lib = await session.cache.get(cacheKey) as LibraryInfo
                    } else if (!options.refresh && session.misses.has(cacheKey)) {
                        // Same outcome as the failed lookup it remembers: the dependency
                        // keeps whatever the parser gave it, untouched.
                        count('cache:known-miss')
                        log.warn(`Skipping ${dep.name}: its registry lookup failed within the last ${MISS_TTL_HOURS}h (--refresh to retry)`)
                        return
                    } else {
                        count('cache:miss')
                        // log.info(`Getting remote information on ${dep.name}`)
                        let fetch = inFlight.get(cacheKey)
                        if (!fetch) {
                            fetch = (async () => {
                                let fetched: LibraryInfo
                                try {
                                    fetched = await retrieveWithRetry(plugin, dep.name)
                                } catch (e: any) {
                                    if (!isRateLimit(e)) session.misses.set(cacheKey)
                                    throw e
                                }
                                if (plugin.checker?.githubSecurityAdvisoryEcosystem && process.env.GH_TOKEN) {
                                    // A failed advisory lookup must not discard the registry data
                                    // already fetched — degrade to no vulnerabilities instead.
                                    try {
                                        fetched.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, fetched.name)
                                    } catch (e: any) {
                                        log.warn(`Vulnerability lookup failed for ${fetched.name}: ${e.message ?? e}`)
                                    }
                                }
                                await session.cache.set(cacheKey, fetched)
                                if (options.refresh) refreshedLibs.push(dep.name)
                                await session.checkpointIfDue()
                                return fetched
                            })()
                            inFlight.set(cacheKey, fetch)
                            fetch.finally(() => inFlight.delete(cacheKey)).catch(() => { /* handled by awaiters */ })
                        }
                        lib = await fetch
                    }
                    dep.libraryInfo = lib
                    dep.vulnerabilities = resolveVulnerabilities(project, dep, lib)
                } catch (e: any) {
                    count('registry:error')
                    log.warn(`Exception getting remote info for ${dep.name}`)
                    log.error(e)
                } finally {
                    depProgressBar.increment()
                    depsWithInfo++
                    log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
                }
            }

            let nextDepIndex = 0
            await Promise.all(Array.from(
                {length: Math.min(REGISTRY_CONCURRENCY, filteredDependencies.length)},
                async () => {
                    while (nextDepIndex < filteredDependencies.length) {
                        const dep = filteredDependencies[nextDepIndex++]
                        await processDep(dep)
                    }
                }
            ))
            depProgressBar.stop()
            projectsBar.increment()
        }
        enrich.end()
        projectsBar.stop()

        const csv = startPhase(`csv:${plugin.name}`)

        const allLibsInfo = projects.flatMap(proj => Object.values(proj.dependencies).map(dep => dep.libraryInfo))
            .filter(it => it !== undefined && it != null).map(it => it as LibraryInfo)

        const allLicenses = _.groupBy(allLibsInfo, licenseOf)

        const licensesHeader = 'License,Libraries,Library Names\n'
        fs.writeFileSync(path.resolve(resultFolder, `${plugin.name}-licenses.csv`),
            licensesHeader + Object.keys(allLicenses).map(license =>
                csvRow([license, allLicenses[license].length, allLicenses[license].map(it => it.name).join(', ')])
            ).join('\n'))

        const header = 'Project Path,Project,Library,Used Version,Latest Version,Used Version Release Date,Latest Version Release Date,Latest-Used,Now-Used,Now-latest,Vulnerabilities,Vulnerability Details,DirectDependency,Type,Licenses\n'
        fs.writeFileSync(path.resolve(resultFolder, `${plugin.name}-libs.csv`), header + projects.flatMap(proj =>
            Object.values(proj.dependencies).map(dep => convertDepToRow(proj, dep))).join('\n'))


        const projectStatsHeader = 'Project Path,Project,Direct Deps,Indirect Deps,Direct Outdated Deps, Direct Outdated %,Indirect Outdated Deps, Indirect Outdated %, Direct Vulnerable Deps, Indirect Vulnerable Deps, Direct Out of Support, Indirect Out of Support\n'
        fs.writeFileSync(path.resolve(resultFolder, `${plugin.name}-project-stats.csv`), projectStatsHeader + projects.map(proj => {
            const enhancedDeps: DependencyInfo[] = Object.values(proj.dependencies).map(dep => {
                const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
                const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim())
                const latestVersionMoment = moment(latestVersion?.timestamp)
                const currentVersionMoment = moment(currentVersion?.timestamp)
                const now = moment()
                const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))

                return {
                    ...dep,
                    direct: directDep,
                    latest_used: latestVersionMoment.diff(currentVersionMoment, 'months'),
                    now_used: now.diff(currentVersionMoment, 'months'),
                    now_latest: now.diff(latestVersionMoment, 'months'),
                } as DependencyInfo
            })
            const directDeps = enhancedDeps.filter(dep => dep.direct)
            const indirectDeps = enhancedDeps.filter(dep => !dep.direct)

            const outdatedThreshold = 15

            const directOutdated = directDeps.filter(dep => dep.latest_used > outdatedThreshold)
            const directOutDatedPercent = directDeps.length == 0 ? 0 : directOutdated.length / directDeps.length * 100
            const indirectOutdated = indirectDeps.filter(dep => dep.latest_used > outdatedThreshold)
            const indirectOutDatedPercent = indirectDeps.length == 0 ? 0 : indirectOutdated.length / indirectDeps.length * 100
            const directVulnerable = directDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0)
            const indirectVulnerable = indirectDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0)

            const outOfSupportThreshold = 24
            const directOutOfSupport = directDeps.filter(dep => dep.now_latest > outOfSupportThreshold)
            const indirectOutOfSupport = indirectDeps.filter(dep => dep.now_latest > outOfSupportThreshold)

            return csvRow([
                proj.path, proj.name, directDeps.length, indirectDeps.length,
                directOutdated.length, directOutDatedPercent, indirectOutdated.length,
                indirectOutDatedPercent, directVulnerable.length, indirectVulnerable.length,
                directOutOfSupport.length, indirectOutOfSupport.length,
            ])
        }).join('\n'))
        csv.end()

        const purlType = purlTypeOfPlugin(plugin) ?? purlTypeOfEcosystem(ecosystemOf(plugin))
        return purlType ? {purlType, projects} : undefined
    }))
    progress.stop()
    const analysed = results.filter((it): it is AnalysisResult => it !== undefined)
    log.info(`Results are written to ${resultFolder}`)
    return analysed
}

interface DependencyInfo extends DepinderDependency {
    direct: boolean
    latest_used: number
    now_used: number
    now_latest: number
}

