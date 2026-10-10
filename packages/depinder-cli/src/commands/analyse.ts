import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {deferSbomFindings, parseSbomProjects, sbomFilesToParse, sbomPluginsForPurlTypes} from '../plugins/sbom'
import {assignPurl} from '../plugins/sbom/dependency-purl'
import {SbomDescription} from '../plugins/sbom/describe'
import {scannerSummaryLine} from '../plugins/sbom/preflight-messages'
import {writeScanProvenance} from '../plugins/sbom/scan-provenance'
import {ScannerPreflight} from '../plugins/sbom/scanner-preflight'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {availableVersions, LibraryInfo} from '../extension-points/library-info'
import {attachGithubAdvisories} from '../utils/library-advisories'
import {Range} from 'semver'
import _ from 'lodash'
import moment from 'moment'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {Cache} from '../cache/cache'
import {sharedCacheDb, sqliteCacheWithCutoff} from '../cache/sqlite-cache'
import {CacheMaxAgeOptions, cacheMaxAgeSeconds, formatDuration, freshnessCutoffMs} from '../cache/max-age'
import {MISS_TTL_HOURS, missCache, MissCache} from '../cache/misses'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {MultiBar, Presets} from 'cli-progress'
import {walkDir} from '../utils/utils'
import {blacklistedGlobs} from '../utils/blacklist'
import { minimatch } from 'minimatch'
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
import {licenseIdentity} from '../blackduck/licenses'
import {classifyInputs, inputFolderOf, SbomSource} from './sources'
import {csvRow} from '../utils/csv'
import {log} from '../utils/logging'
import {count, enableProfile, logProfile, startPhase, timePhase, timePhaseSync} from '../utils/profile'
import {DEFAULT_RESOLVER_URL, ResolverConfig, ResolverOptions, resolverConfig} from '../resolver/config'
import {resetResolverClient} from '../resolver/client'
import {bulkResolve, BulkResolveOutcome, PluginProjects} from '../resolver/bulk-resolve'
import {resetBulkResolve} from '../resolver/bulk-memory'
import {createRegistryFallback, isRateLimit, RegistryFallback} from '../fallback/registry-fallback'
import {REGISTRY_LIMITS_ENV, resolveRegistryLimits} from '../fallback/registry-limits'
import {fallbackLookupName, logLookupFailure} from '../fallback/lookup-name'
import {fixedReportNow, REPORT_NOW_ENV, reportNow} from '../utils/report-clock'
import {usesVulnServer, vulnServerConfig, VulnServerConfig} from '../vuln-sources/server'
import {
    collectSbomTargets,
    localPrescan,
    localScannerPreflight,
    startServerVulnerabilities,
    VulnOutcome,
    vulnSummaryLine,
    writeServerProvenance,
} from '../vuln-sources/run'

export interface AnalyseOptions extends ResolverOptions, CacheMaxAgeOptions {
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
    /** SBOM sources: DepMiner's `index.json` for Black Duck's `Path` prefix; `false` for `--no-depminer-index`. */
    depminerIndex?: string | false
    /** `false` for `--no-vuln-server`, `true` for `--vuln-server` (kept on under `--no-resolver`), else unset. */
    vulnServer?: boolean
    /** `npm=16,cargo=1:1000`: per-ecosystem registry limits over `DEPINDER_REGISTRY_LIMITS` and the defaults. */
    registryLimits?: string
}

/** A factory rather than a single instance, so tests can parse arguments from a clean slate. */
export function createAnalyseCommand(): Command {
    return new Command()
        .name('analyse')
        .argument('[folders...]', 'Folders to walk for CycloneDX SBOMs')
        // Both value-taking options need a <value> placeholder: without one Commander registers
        // them as booleans, so `-r out` set `{R: true}` and left `out` to be walked as another
        // folder, and `--plugins` never reached getPluginsFromNames.
        .option('-r, --results <folder>', 'The results folder', 'results')
        .option('--refresh', 'Refresh the cache', false)
        .option('--cache-max-age <duration>',
            'Cached packages older than this are fetched again: <n>[s|m|h|d], a bare number being seconds; '
            + 'DEPINDER_CACHE_MAX_AGE when unset, else 1d')
        .option('-p, --plugins [plugins...]', 'A list of plugins')
        .option('--project-name <name>',
            'SBOM sources: the name to write in the Project path column and at the head of every dependency path')
        .option('--depminer-index <file>', 'SBOM sources: DepMiner\'s index.json (or its folder), whose manifests give Path '
            + 'its Black Duck project prefix and drop own code from the chain; found beside the input when unset')
        .option('--no-depminer-index', 'SBOM sources: do not read the DepMiner index; Path keeps the plain directory prefix')
        .option('--vuln-source <sources>',
            'Vulnerability sources for the SBOM route: a comma-separated list of trivy, grype, github, all',
            DEFAULT_VULN_SOURCE)
        .option('--github-token-file <file>',
            'Dotenv-style file holding GH_TOKEN_1, GH_TOKEN_2, ... for --vuln-source github',
            DEFAULT_TOKEN_FILE)
        .option('--github-max-age <hours>',
            'Re-download a cached ecosystem\'s GitHub advisories when they are older than this',
            String(DEFAULT_MAX_AGE_HOURS))
        .option('--resolver-url <url>',
            'Base URL of the bulk purl resolver, called by default; DEPINDER_RESOLVER_URL when unset, '
            + `else ${DEFAULT_RESOLVER_URL}. Needs DEPINDER_RESOLVER_TOKEN`)
        .option('--no-resolver', 'Do not call the bulk resolver, which is on by default; fetch every package from the registries')
        .option('--vuln-server',
            'Ask the resolver\'s server for vulnerabilities even with --no-resolver, which otherwise turns both off')
        .option('--no-vuln-server',
            'Scan the SBOMs with the local Trivy and Grype even when the resolver\'s server can answer vulnerabilities')
        .option('--registry-limits <limits>',
            'Registry requests at once per ecosystem, with an optional gap in ms: npm=16,cargo=1:1000; '
            + 'over DEPINDER_REGISTRY_LIMITS and the defaults')
        .option('--profile', 'Print a phase timing and request count summary at the end', false)
        // Only the two arguments: Commander also passes the Command itself, which must not leak
        // into an optional parameter.
        .action((folders: string[], options: AnalyseOptions) => analyseFiles(folders, options))
}

export const analyseCommand = createAnalyseCommand()


function extractLicenses(dep: DepinderDependency) {
    // Older cache entries can hold null licenses; skip them.
    return dep.libraryInfo?.licenses?.filter(it => it != null).map(it => {
        if (typeof it === 'string') return it.substring(0, 100); else return JSON.stringify(it)
    })
}

/**
 * The release moment of a version, or `undefined` when there is none: the version is not in the
 * registry's list, or the registry has no date for it (`NaN`). `moment(undefined)` is *now* and
 * `moment(NaN)` formats as "Invalid date", so every date column goes through here and a missing
 * date becomes a blank cell rather than this month or a string nobody can sort on.
 */
function releaseMoment(timestamp: number | undefined): moment.Moment | undefined {
    return timestamp !== undefined && Number.isFinite(timestamp) ? moment(timestamp) : undefined
}

/** Whole months from `earlier` to `later`; `undefined` (a blank cell) when either date is missing. */
function monthsBetween(later: moment.Moment | undefined, earlier: moment.Moment | undefined): number | undefined {
    return later && earlier ? later.diff(earlier, 'months') : undefined
}

/** The `Type` column of libs.csv stays blank: neither Syft nor Trivy records a dependency scope. */
const NO_DEPENDENCY_SCOPE = ''

export function convertDepToRow(proj: DepinderProject, dep: DepinderDependency): string {
    const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
    const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim())
    const latestVersionMoment = releaseMoment(latestVersion?.timestamp)
    const currentVersionMoment = releaseMoment(currentVersion?.timestamp)
    const now = moment(reportNow())

    const dateFormat = 'MMM YYYY'
    const vulnerabilities = dep.vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n')
    const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))
    return csvRow([
        proj.path, proj.name, dep.name, dep.version, latestVersion?.version,
        currentVersionMoment?.format(dateFormat), latestVersionMoment?.format(dateFormat),
        monthsBetween(latestVersionMoment, currentVersionMoment),
        monthsBetween(now, currentVersionMoment), monthsBetween(now, latestVersionMoment),
        dep.vulnerabilities?.length, vulnerabilities, directDep, NO_DEPENDENCY_SCOPE, extractLicenses(dep),
    ])
}

// Phase 1 — one plugin's parse: its projects from every SBOM of the run, in file order.
async function parsePluginProjects(plugin: Plugin, sbomFiles: string[]): Promise<DepinderProject[]> {
    const projects: DepinderProject[] = []
    for (const sbomFile of sbomFiles) {
        log.info(`Parsing the ${plugin.purlType} projects of ${sbomFile}`)
        try {
            projects.push(...await parseSbomProjects(sbomFile, plugin.purlType))
        } catch (e: any) {
            log.warn(`Exception parsing the ${plugin.purlType} projects of ${sbomFile}`)
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
 *  - otherwise, the library-level advisories on its LibraryInfo -> narrow to this version
 */
export function resolveVulnerabilities(project: DepinderProject, dep: DepinderDependency, lib: LibraryInfo): Vulnerability[] {
    if (project.exactVersionVulnerabilities) return dep.vulnerabilities ?? []
    return advisoriesMatchingVersion(lib, dep.version)
}

/**
 * The license a library is grouped under. Library-level `licenses` is the field every registry
 * fills (and the one libs.csv reports); the per-version list is optional and left empty by some
 * (maven sets `licenses: []` on every version), so it is only the fallback, for registries that
 * fill nothing else.
 * It is read the same way as the Black Duck licence columns, so both outputs agree.
 */
export function licenseOf(lib: LibraryInfo): string {
    const license = lib.licenses?.find(it => typeof it === 'string' && it)
        ?? availableVersions(lib.versions).flatMap(it => it.licenses).find(it => typeof it === 'string' && it)
    return license ? licenseIdentity(license) : 'unknown'
}

function cacheHit(cache: Cache, cacheKey: string, dep: DepinderDependency, refresh: boolean, refreshedLibs: string[]): boolean {
    if (refresh && !refreshedLibs.includes(dep.name)) {
        return false
    }
    return cache.has(cacheKey)
}

/**
 * What one plugin's pass produced: the purl type its components carry, and the projects it
 * enriched. The Black Duck-shaped files are built out of this, which is what keeps the SBOM
 * sources from growing a second copy of the analysis.
 */
export type AnalysisResult = AnalysedEcosystem

/**
 * Phase 1b: makes sure every dependency carries its purl (`assignPurl`): the SBOM's own, as the
 * CycloneDX parser set it, else one spelled from the plugin's purl type. Returns how many
 * dependencies end up with a purl, from either source.
 */
export function assignPurls(pluginProjects: PluginProjects[]): number {
    let named = 0
    for (const {plugin, projects} of pluginProjects) {
        for (const project of projects) {
            for (const dep of Object.values(project.dependencies)) {
                if (assignPurl(plugin, dep)) named++
            }
        }
    }
    return named
}

/** One results subfolder's worth of work: the plugins that run and the source's SBOMs, in walk order. */
export interface PlannedRun {
    /** `trivy` or `syft`; also the subfolder under the results folder. */
    source: string
    /** Absolute: `<results>/<source>`. */
    folder: string
    /** The input folder the source's files came from — the project-name fallback. */
    inputFolder: string
    plugins: Plugin[]
    sboms: SbomDescription[]
}

/**
 * Which sources get a run, and with which plugins: per SBOM producer, the `sbom-*` plugins the
 * source's purl types call for (an explicit `-p` selects the plugins it names instead), into
 * `<producer>/`.
 */
export function planRuns(sources: SbomSource[], selected: Plugin[], options: AnalyseOptions, resultRoot: string, folders: string[]): PlannedRun[] {
    const runs: PlannedRun[] = []
    const explicit = !!options.plugins?.length
    for (const source of sources) {
        const purlTypes = new Set(source.sboms.flatMap(it => [...it.purlTypes]))
        const plugins = explicit ? selected : sbomPluginsForPurlTypes(purlTypes)
        if (plugins.length === 0) {
            if (explicit) log.info(`${source.name}: skipped, --plugins names no known plugin`)
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
            sboms: source.sboms,
        })
    }
    return runs
}

interface SbomPreparation {
    /** The local scanner preflight, when the run scans locally from the start. */
    preflight?: ScannerPreflight
    hasGithubToken: boolean
    /**
     * When the vulnerability server was asked: settles once every project has its findings, from
     * the server or from the local scan it fell back to. Never rejects.
     */
    vulnerabilities?: Promise<VulnOutcome>
}

/**
 * Everything the SBOM route does once per process, before any parsing: either the question to the
 * vulnerability server — posted here and awaited only where the findings are read — or the local
 * scanner preflight and the up-front scan of every SBOM any run will parse; and the GitHub advisory
 * refresh.
 */
async function prepareSbomScans(runs: PlannedRun[], options: AnalyseOptions, vulnServer?: VulnServerConfig): Promise<SbomPreparation> {
    deferSbomFindings(false)
    const sbomFiles = runs.flatMap(it => it.sboms.map(sbom => sbom.file))
    const hasGithubToken = !!process.env.GH_TOKEN
    const sources = parseVulnSources(options.vulnSource ?? DEFAULT_VULN_SOURCE)
    setVulnSources(sources)
    log.info(`Vulnerability sources: ${describeVulnSources(sources)}`)
    const prescanFiles = () => runs.flatMap(it => sbomFilesToParse(it.plugins, it.sboms.map(sbom => sbom.file)))

    // The vulnerability server stands in for both local scanners at once, so only when both are
    // selected. Asked first, before the GitHub refresh and the cache load, because nothing has to
    // wait for it: the parser is told to leave the findings to it, and the pipeline awaits it just
    // before the findings are read. Its findings are merged with GitHub's, so they are attached
    // only once the refresh below is done.
    let githubDone: () => void = () => undefined
    const githubReady = new Promise<void>(resolve => { githubDone = resolve })
    let vulnerabilities: Promise<VulnOutcome> | undefined
    if (vulnServer && usesVulnServer(sources)) {
        const targets = await timePhase('vuln:purls', () => collectSbomTargets(runs))
        deferSbomFindings(true)
        vulnerabilities = startServerVulnerabilities(vulnServer, targets, {githubReady, prescanFiles, hasGithubToken})
    }

    // Scanner preflight, before any parsing: the SBOM parsers shell out to Trivy and Grype, so a
    // missing binary is reported once, up front, rather than only as empty vulnerability columns.
    // Never aborts: a run without scanners is degraded, not invalid. With a vulnerability server it
    // runs only if the server fails.
    const runsLocalScanners = !vulnerabilities && (sources.trivy || sources.grype)
    const preflight = runsLocalScanners ? await localScannerPreflight(hasGithubToken) : undefined

    // The GitHub cache is refreshed before any parsing, and only for the ecosystems these SBOMs
    // actually contain — a Ruby project never downloads npm's 7,000 advisories. A refresh failure
    // is a warning: whatever is already cached still matches.
    try {
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
    } finally {
        githubDone()
    }

    // Trivy and Grype run on every SBOM a plugin will parse, all at once and up front.
    if (preflight) await localPrescan(prescanFiles)
    return {preflight, hasGithubToken, vulnerabilities}
}

/** The caches a run reads and writes. Every write is durable on its own; misses are pruned at the end. */
export interface CacheSession {
    cache: Cache
    misses: MissCache
}

function openCacheSession(cutoffMs: number): CacheSession {
    const file = timePhaseSync('cache:load', () => sharedCacheDb().file)
    log.info(`Using the local SQLite cache: ${file}`)
    return {cache: sqliteCacheWithCutoff(cutoffMs), misses: missCache}
}

/**
 * `depinder analyse <folders...>`: one results subfolder per source found under the folders.
 *
 * The files decide, not the folders: every walked file is classified by content (`sources.ts`),
 * so a folder of Trivy SBOMs and one of Syft SBOMs can be given in one invocation, or in two.
 * Each SBOM source gets the `sbom-*` plugin CSVs, the scan provenance and the Black Duck-shaped
 * files under `<results>/<producer>/`; anything that is not a CycloneDX SBOM is ignored. A
 * subfolder exists only when its source had input.
 */
async function analyseFiles(folders: string[], options: AnalyseOptions): Promise<void> {
    if (options.profile) enableProfile()
    // Read first, so a malformed fixed date stops the run before any work is done.
    const fixedNow = fixedReportNow()
    if (fixedNow) log.info(`Report date fixed at ${fixedNow.toISOString()} (${REPORT_NOW_ENV}); ages in the CSVs are measured from it`)
    const registries = createRegistryFallback(resolveRegistryLimits({flag: options.registryLimits, env: process.env[REGISTRY_LIMITS_ENV]}))
    const resultRoot = path.resolve(process.cwd(), options.results || 'results')
    const allFiles = folders.flatMap(it => walkDir(it))
    const selected = getPluginsFromNames(options.plugins)
    const runs = planRuns(classifyInputs(allFiles), selected, options, resultRoot, folders)
    if (runs.length === 0) {
        log.warn(`Nothing to analyse under ${folders.join(', ') || '.'}`)
        return
    }

    // Read before the parse rather than after it, so a missing token is reported in the first
    // second of a run instead of the tenth minute.
    // One cutoff for the whole run, taken before anything is fetched: every row written by this
    // run is fresh for the rest of it, and the resolver is sent the very same instant. `--refresh`
    // wants nothing older than the run itself, from the resolver as from the registries.
    const runStartMs = Date.now()
    const maxAgeSeconds = cacheMaxAgeSeconds(options)
    const cutoffMs = freshnessCutoffMs(maxAgeSeconds, runStartMs)
    log.info(`Cache max age: ${formatDuration(maxAgeSeconds)} (entries written before ${new Date(cutoffMs).toISOString()} are expired)`)

    resetResolverClient()
    resetBulkResolve()
    const configured = resolverConfig(options)
    const resolver = configured && {...configured, freshAfterMs: options.refresh ? runStartMs : cutoffMs}
    if (resolver) log.info(`Bulk resolver: ${resolver.url}, waiting at most ${Math.round(resolver.maxWaitMs / 1000)}s for it`)
    // Same server and token as the resolver; `--no-vuln-server` keeps the scan local, and
    // `--vuln-server` keeps the server's scan when `--no-resolver` turned the resolver off.
    const vulnServer = vulnServerConfig(
        configured ?? (options.resolver === false && options.vulnServer === true ? resolverConfig({...options, resolver: true}) : undefined), options)

    const prep = await prepareSbomScans(runs, options, vulnServer)
    const session = openCacheSession(cutoffMs)
    let vulnOutcome: VulnOutcome | undefined
    try {
        for (const run of runs) {
            const sbomFiles = run.sboms.map(it => it.file)
            const analysed = await runAnalysis(sbomFiles, run.plugins, run.folder, options, session, resolver, prep.vulnerabilities, registries)
            // Already settled: `runAnalysis` waited for it before reading any finding.
            vulnOutcome = prep.vulnerabilities ? await prep.vulnerabilities : undefined
            const preflight = prep.preflight
                ?? (vulnOutcome?.source === 'local' ? vulnOutcome.preflight : undefined)
            // Only when some scanner ran, here or on the server: the file records their versions
            // and DB builds, which is what makes a vulnerability count reproducible.
            try {
                if (vulnOutcome?.source === 'server') {
                    const provenanceFile = writeServerProvenance(run.folder, vulnOutcome, run.sboms)
                    log.info(`Scan provenance written to ${provenanceFile}`)
                } else if (preflight) {
                    const fallback = vulnOutcome?.source === 'local' && vulnOutcome.fallbackReason
                        ? {reason: vulnOutcome.fallbackReason}
                        : undefined
                    const provenanceFile = await writeScanProvenance(run.folder, prep.hasGithubToken, run.sboms, fallback)
                    log.info(`Scan provenance written to ${provenanceFile}`)
                }
            } catch (e: any) {
                log.warn(`Could not write scan provenance: ${e?.message ?? e}`)
            }
            writeBlackDuckForSource(run.sboms, analysed, run.folder, run.inputFolder, options)
            log.info(`Results for ${run.source} are written to ${run.folder}`)
        }
    } finally {
        timePhaseSync('cache:prune', () => session.misses.prune())
    }

    // Repeated here because the preflight banner is thousands of log lines back by now, and
    // because a CSV is only readable next to the matcher and DB build that produced it.
    const summary = prep.preflight
        ? scannerSummaryLine(prep.preflight, prep.hasGithubToken)
        : vulnOutcome && vulnSummaryLine(vulnOutcome, prep.hasGithubToken)
    if (summary) log[summary.level](summary.text)
    log.info('Done')
    logProfile()
}

/**
 * Runs `plugins` over `sbomFiles` and writes each plugin's three CSVs into `resultFolder`. The
 * enrichment is shared by every source: this is the one place a dependency is looked up.
 */
export async function runAnalysis(
    sbomFiles: string[], plugins: Plugin[], resultFolder: string, options: AnalyseOptions, session: CacheSession,
    resolver?: ResolverConfig, vulnerabilities?: Promise<unknown>,
    registries: RegistryFallback = createRegistryFallback(resolveRegistryLimits({env: process.env[REGISTRY_LIMITS_ENV]})),
): Promise<AnalysisResult[]> {
    if (!fs.existsSync(resultFolder)) {
        fs.mkdirSync(resultFolder, {recursive: true})
        log.info(`Creating results dir ${resultFolder}`)
    }
    const progress = new MultiBar({}, Presets.shades_grey)

    // Phase 1 — parse: SBOMs → DepinderProject[] per plugin, side by side. Nothing leaves the machine
    // yet. Every plugin finishes parsing before any enrichment starts, because a bulk question is
    // only worth asking once it can cover the whole run.
    const pluginProjects: PluginProjects[] = await Promise.all(
        plugins.map(async (plugin): Promise<PluginProjects> => {
            log.info(`Plugin ${plugin.name} starting`)
            const projects: DepinderProject[] = await timePhase(`parse:${plugin.name}`, () =>
                parsePluginProjects(plugin, sbomFiles))
            return {plugin, projects}
        }))

    // Phase 1b — the purl for every dependency: the SBOM's own, else one spelled from its name.
    const named = assignPurls(pluginProjects)

    // Phase 2 — the bulk resolver, when one is configured: local cache → our server → registries.
    // What the cache cannot answer is asked of the server once per purl per process, bounded by the
    // deadline; whatever has no usable answer by then goes to the registry fallback in phase 3. It
    // only fills the cache (and hands phase 3 what it took), so nothing below can tell where an
    // entry came from.
    const bulk: BulkResolveOutcome = resolver
        ? await timePhase('resolve:bulk', async () => {
            log.info(`Asking the resolver about up to ${named} dependency purls`)
            return bulkResolve(resolver, pluginProjects, session.cache, {refresh: options.refresh, vulnerabilitiesReady: vulnerabilities})
        })
        : {written: new Set<string>(), libs: new Map<string, LibraryInfo>(), requested: 0, resolved: 0}
    const bulkWritten = bulk.written

    // Phase 2h — the vulnerability server's answer, asked at the start of the run: phase 3 is the
    // first to read a finding or `exactVersionVulnerabilities`, so this is as late as the wait can
    // go. Usually long settled by now; if the server failed, this is where the local scan it fell
    // back to is waited for.
    if (vulnerabilities) await timePhase('vuln:server-wait', () => vulnerabilities)

    // Phase 3 — enrichment: per dep, cache → miss cache → registry fallback. The plugins run side by
    // side, each registry behind its ecosystem's limits, so a registry that stalls does not hold the
    // others up. Whatever phase 2 cached is a plain cache hit here and never reaches a registry.
    const results = await Promise.all(pluginProjects.map(async ({plugin, projects}): Promise<AnalysisResult> => {
        // A library the resolver just refreshed counts as refreshed: without this, `--refresh`
        // would discard the answer that was fetched seconds ago and go back to the registry.
        const keyPrefix = `${ecosystemOf(plugin)}:`
        const refreshedLibs = [...bulkWritten].filter(it => it.startsWith(keyPrefix)).map(it => it.slice(keyPrefix.length))
        const inFlight = new Map<string, Promise<LibraryInfo>>()
        const purlType = plugin.purlType

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
                    // Keyed by ecosystem, not plugin name: `sbom-java` caches under `java`, the
                    // namespace every existing entry was written under. `update.ts` reconstructs
                    // library names from this same prefix.
                    const cacheKey = `${ecosystemOf(plugin)}:${dep.name}`
                    // Phase 2 built this object and wrote it to the cache moments ago; reading it
                    // back would be a `has`, a `get` and a `JSON.parse` of ~10 KB to arrive at the
                    // same value. Still a cache hit — that is what it is — and `--refresh` cannot
                    // be affected, because every key in here is also in `refreshedLibs`. Deps
                    // sharing a library share the object, exactly as the `inFlight` path below
                    // already has them do.
                    const justResolved = bulk.libs.get(cacheKey)
                    if (justResolved) {
                        count('cache:hit')
                        lib = justResolved
                    } else if (cacheHit(session.cache, cacheKey, dep, options.refresh, refreshedLibs)) {
                        count('cache:hit')
                        lib = session.cache.get(cacheKey) as LibraryInfo
                    } else if (!options.refresh && session.misses.has(cacheKey)) {
                        // Same outcome as the failed lookup it remembers: the dependency
                        // keeps whatever the parser gave it, untouched.
                        count('cache:known-miss')
                        log.warn(`Skipping ${dep.name}: its registry lookup failed within the last ${MISS_TTL_HOURS}h (--refresh to retry)`)
                        return
                    } else {
                        // An expired entry is a miss like any other; the count only tells them apart.
                        count(!options.refresh && session.cache.isExpired(cacheKey) ? 'cache:expired' : 'cache:miss')
                        // log.info(`Getting remote information on ${dep.name}`)
                        let fetch = inFlight.get(cacheKey)
                        if (!fetch) {
                            // One per real registry lookup (deps sharing a library share the
                            // inFlight fetch and are not counted again): with a resolver, these
                            // are the packages it had no usable answer for in time.
                            count('registry:fetch')
                            count(`registry:fetch:${ecosystemOf(plugin)}`)
                            fetch = (async () => {
                                let fetched: LibraryInfo
                                try {
                                    fetched = await registries.lookup({type: purlType, name: fallbackLookupName(dep)})
                                } catch (e: any) {
                                    if (!isRateLimit(e)) session.misses.set(cacheKey)
                                    throw e
                                }
                                await attachGithubAdvisories(fetched, plugin)
                                session.cache.set(cacheKey, fetched)
                                if (options.refresh) refreshedLibs.push(dep.name)
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
                    logLookupFailure(dep.name, ecosystemOf(plugin), e)
                } finally {
                    depProgressBar.increment()
                    depsWithInfo++
                    log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
                }
            }

            let nextDepIndex = 0
            await Promise.all(Array.from(
                {length: Math.min(registries.packagesAtOnce(purlType), filteredDependencies.length)},
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

        // Everything below writes the CSV reports.
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
                const latestVersionMoment = releaseMoment(latestVersion?.timestamp)
                const currentVersionMoment = releaseMoment(currentVersion?.timestamp)
                const now = moment(reportNow())
                const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))

                // A missing date is NaN here, which no threshold below counts as outdated or out
                // of support.
                return {
                    ...dep,
                    direct: directDep,
                    latest_used: monthsBetween(latestVersionMoment, currentVersionMoment) ?? NaN,
                    now_used: monthsBetween(now, currentVersionMoment) ?? NaN,
                    now_latest: monthsBetween(now, latestVersionMoment) ?? NaN,
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

        return {purlType, projects}
    }))
    progress.stop()
    log.info(`Results are written to ${resultFolder}`)
    return results
}

interface DependencyInfo extends DepinderDependency {
    direct: boolean
    latest_used: number
    now_used: number
    now_latest: number
}

