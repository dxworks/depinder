import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {purlTypeOfPlugin, registryTypeOfPlugin, sbomFilesToParse, sbomPluginsForPurlTypes} from '../plugins/sbom'
import {SbomDescription} from '../plugins/sbom/describe'
import {deferSbomFindings} from '../plugins/sbom'
import {ScannerPreflight, scannerSummaryLine, writeScanProvenance} from '../plugins/sbom/local-scan'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {availableVersions, LibraryInfo} from '../extension-points/library-info'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {attachGithubAdvisories} from '../utils/library-advisories'
import {Range} from 'semver'
import _ from 'lodash'
import spdxCorrect from 'spdx-correct'
import moment from 'moment'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {Cache, noCache} from '../cache/cache'
import {sharedCacheDb, sqliteCacheWithCutoff} from '../cache/sqlite-cache'
import {CacheMaxAgeOptions, cacheMaxAgeSeconds, formatDuration, freshnessCutoffMs} from '../cache/max-age'
import {MISS_TTL_HOURS, missCache, MissCache, noMissCache} from '../cache/misses'
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
import {classifyInputs, inputFolderOf, InputSources} from './sources'
import {csvRow} from '../utils/csv'
import {log} from '../utils/logging'
import {count, enableProfile, logProfile, startPhase, timePhase} from '../utils/profile'
import {DEFAULT_RESOLVER_URL, ResolverConfig, ResolverOptions, resolverConfig} from '../resolver/config'
import {PackageRecord, ResolvedEntry, resetResolverClient, resolvePurls} from '../resolver/client'
import {toLibraryInfo} from '../resolver/adapter'
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const licenseIds = require('spdx-license-ids/')

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100

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
        // .argument('[depext-files...]', 'A list of files to parse for dependency information')
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
        .action(analyseFiles)
}

export const analyseCommand = createAnalyseCommand()


function extractLicenses(dep: DepinderDependency) {
    // Caches written before the npm registrar stopped emitting [undefined] hold [null]; skip it.
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
        dep.vulnerabilities?.length, vulnerabilities, directDep, dep.type, extractLicenses(dep),
    ])
}

// FLOW 1b — one plugin's parse: the extractor groups the files it claims, the parser turns each group into a DepinderProject.
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
export function licenseOf(lib: LibraryInfo): string {
    const license = lib.licenses?.find(it => typeof it === 'string' && it)
        ?? availableVersions(lib.versions).flatMap(it => it.licenses).find(it => typeof it === 'string' && it)
    if (!license || typeof license !== 'string')
        return 'unknown'
    if (!licenseIds.includes(license))
        return spdxCorrect(license) || 'unknown'
    return license
}

async function cacheHit(cache: Cache, cacheKey: string, dep: DepinderDependency, refresh: boolean, refreshedLibs: any[]) {
    if (refresh && !refreshedLibs.includes(dep.name)) {
        return false
    }
    return cache.has(cacheKey)
}

/** GitHub advisory lookups at once for answers the resolver gave. */
const ADVISORY_LOOKUP_CONCURRENCY = 8
/**
 * How often the caches are flushed mid-run, so a crash loses at most this much work. Time-based
 * rather than every N lookups because a flush serialises the whole positive cache (tens of MB),
 * and doing that every 50 lookups on a cold run cost more than the lookups it protected.
 */
const CACHE_CHECKPOINT_MS = 60_000

/**
 * What one plugin's pass produced: the purl type its components carry, and the projects it
 * enriched. The Black Duck-shaped files are built out of this, which is what keeps the SBOM
 * sources from growing a second copy of the analysis.
 */
export type AnalysisResult = AnalysedEcosystem

/** A plugin and the projects its parser produced: what phase 1 hands to phases 2 and 3. */
export interface PluginProjects {
    plugin: Plugin
    projects: DepinderProject[]
}

/**
 * Phase 1b: makes sure every dependency carries its purl.
 *
 * The SBOM is the source: the CycloneDX parser already set `dep.purl` from the component's own
 * purl, normalised (see `normalizePurl`), so a golang module keeps the case Syft recorded and
 * `pkg:cargo/tikv-jemalloc-sys@0.7.1%2B5.3.1-...` stays exactly as both tools wrote it. `checker.getPURL`
 * is only the fallback, for a component whose purl did not parse; it needs a version to spell one, so a dependency with
 * neither keeps no purl and takes the registrar path. Returns how many dependencies end up with a
 * purl, from either source.
 */
export function assignPurls(pluginProjects: PluginProjects[]): number {
    let named = 0
    for (const {plugin, projects} of pluginProjects) {
        const getPURL = plugin.checker?.getPURL
        for (const project of projects) {
            for (const dep of Object.values(project.dependencies)) {
                if (!dep.purl && getPURL) {
                    const version = dep.version?.trim()
                    if (!version) continue
                    dep.purl = getPURL(dep.name, version)
                }
                if (dep.purl) named++
            }
        }
    }
    return named
}

async function allCached(cache: Cache, keys: Set<string>): Promise<boolean> {
    for (const key of keys) {
        if (!await cache.has(key)) return false
    }
    return true
}

async function anyExpired(cache: Cache, keys: Set<string>): Promise<boolean> {
    if (!cache.isExpired) return false
    for (const key of keys) {
        if (await cache.isExpired(key)) return true
    }
    return false
}

/**
 * The `updated_at` a resolver answer is cached with: the server's `confirmed_at`, the latest
 * instant it can show the facts matched the registry, in epoch milliseconds.
 *
 * Stamping "now" instead made a package the server had last confirmed days ago — every
 * `refreshing` one, by definition — look fresh locally for a full max age, so the stale facts were
 * reused run after run without the server ever being asked again. Absent, `null` or unparseable
 * means "no proof of when", which is `0`: written already expired. Never later than now, in case
 * the server's clock runs ahead of this one.
 */
export function confirmedAtMs(confirmedAt: string | null | undefined, now = Date.now()): number {
    const ms = confirmedAt ? Date.parse(confirmedAt) : NaN
    return Number.isFinite(ms) ? Math.min(ms, now) : 0
}

/**
 * The resolver is asked about a purl at most once per process.
 *
 * One `analyse` can run two sources — the Trivy and the Syft SBOMs of the same repositories — and
 * each has a bulk phase of its own. A `refreshing` answer the first one wrote is stored already
 * expired (see `confirmedAtMs`), so without this the second would ask the server about the same
 * purl again: a retry by another name. Instead a purl in `askedThisProcess` is never sent again,
 * and every answer that was taken is kept here under its cache key, with the `updated_at` it was
 * written with, so a later source hands the very same object to its phase 3 — or, under a key the
 * earlier source did not write, the same answer written afresh (`answeredPurls`). A purl that was asked
 * and got no usable answer has nothing in here: its key is a cache hit if some registrar has since
 * filled it, and goes to the registrars otherwise.
 *
 * Reset per `analyseFiles`, next to `resetResolverClient`.
 */
const askedThisProcess = new Set<string>()
const answeredThisProcess = new Map<string, {lib: LibraryInfo, updatedAt: number}>()
/**
 * The same answers, per purl as sent: the package and its `updated_at`. Needed because one purl can
 * belong to different cache keys in different sources — Trivy lowercases a golang module path that
 * Syft keeps in its original case, so `go:github.com/kimmachinegun/automemlimit` and
 * `go:github.com/KimMachineGun/automemlimit` are one purl and two keys. A later source whose key
 * the earlier one never wrote gets the earlier answer written under it, rather than a registry call.
 */
const answeredPurls = new Map<string, {pkg: PackageRecord, updatedAt: number}>()

/** For tests, and for a second `analyseFiles` in the same process. */
export function resetBulkResolve(): void {
    askedThisProcess.clear()
    answeredThisProcess.clear()
    answeredPurls.clear()
}

/** What the bulk phase left behind for phase 3: the cache keys it filled, and a count or two. */
export interface BulkResolveOutcome {
    /** Cache keys written from resolver answers, `${ecosystem}:${library}`. */
    written: Set<string>
    /**
     * The very objects that were written, under the same keys — and, for a purl an earlier source
     * of the same process already asked about, the objects that source took (`answeredThisProcess`).
     *
     * An optimisation, not a second cache: the SQLite row remains the durable copy and this map
     * dies with the run. It exists because phase 3 otherwise re-reads what phase 2 built seconds
     * earlier — a `has` plus a `get`, so two SQLite statements and a `JSON.parse` of ~10 KB, once
     * per dependency. On the warm benchmark that was 15,587 round trips through the database for
     * entries already sitting in memory.
     */
    libs: Map<string, LibraryInfo>
    /** How many distinct purls were actually asked about, after dedupe, the cache check and the purls already asked this process. */
    requested: number
    /** How many of those came back `resolved`. */
    resolved: number
}

/**
 * Phase 2: one ask of the resolver for every purl the cache cannot answer, written into the same
 * cache phase 3 reads. Each purl is asked once per process, however many sources name it.
 *
 * The map is global on purpose. A purl identifies a library-version the same way whichever plugin
 * found it, so `sbom-java` reading a Trivy and a Syft SBOM of the same repository, or twenty projects sharing a
 * dependency, produce one entry and one question. What comes back `resolved` is written under
 * every cache key that purl belongs to — the key is per ecosystem, and two plugins can share one —
 * so `cacheHit` in phase 3 finds it and the registrar is never called. Everything else (`pending`,
 * `not_found`, `invalid`, or a resolver that never answered) is left alone and falls through to
 * the registrar chain and the miss cache exactly as before.
 *
 * Answers arrive as a stream, and each one is written as it arrives rather than after the last:
 * the phase returns once the stream has ended and every advisory lookup it started has finished.
 *
 * `resolve` is a parameter so the phase can be tested without a server.
 *
 * `vulnerabilitiesReady`, when given, settles once every project's findings are attached — the
 * vulnerability server's, or the local scan's it fell back to. Until then a project without
 * `exactVersionVulnerabilities` is undecided rather than a reader of advisories: see FLOW 2g.
 */
export async function bulkResolve(
    config: ResolverConfig,
    pluginProjects: PluginProjects[],
    cache: Cache,
    options: {refresh?: boolean, vulnerabilitiesReady?: Promise<unknown>} = {},
    resolve: typeof resolvePurls = resolvePurls
): Promise<BulkResolveOutcome> {
    // FLOW 2a — every purl in the run, deduped, with the (plugin, dep) pairs that own it.
    const byPurl = new Map<string, {plugin: Plugin, dep: DepinderDependency}[]>()
    // The cache keys whose advisories phase 3 will actually read: those with at least one dependency
    // in a project no SBOM scan answered for (`exactVersionVulnerabilities` unset, see
    // `plugins/sbom/index.ts`). A project the scanners covered takes its findings from the scan and
    // never looks at `lib.vulnerabilities`, so a GitHub call for it would be paid and thrown away.
    // The flag is set while parsing, in phase 1, so it is already known here — unless the findings
    // come from the vulnerability server, whose answer may still be on its way: then a project
    // without the flag is only undecided (`advisoriesUndecided`, settled in FLOW 2g).
    const advisoriesRead = new Set<string>()
    const advisoriesUndecided = new Map<string, DepinderProject[]>()
    for (const {plugin, projects} of pluginProjects) {
        for (const project of projects) {
            for (const dep of Object.values(project.dependencies)) {
                if (!dep.purl) continue
                // The same filter phase 3 applies, so the resolver is never asked about a library
                // this run has been told to ignore.
                if (blacklistedGlobs.some(glob => minimatch(dep.name, glob))) continue
                const entries = byPurl.get(dep.purl)
                if (entries) entries.push({plugin, dep})
                else byPurl.set(dep.purl, [{plugin, dep}])
                if (project.exactVersionVulnerabilities) continue
                const key = `${ecosystemOf(plugin)}:${dep.name}`
                if (!options.vulnerabilitiesReady) {
                    advisoriesRead.add(key)
                    continue
                }
                const owners = advisoriesUndecided.get(key)
                if (!owners) advisoriesUndecided.set(key, [project])
                else if (!owners.includes(project)) owners.push(project)
            }
        }
    }

    // FLOW 2b — drop the purls this process already asked about, and those the local cache already
    // covers; what is left is the ask list.
    const written = new Set<string>()
    const libs = new Map<string, LibraryInfo>()
    const reusedPurls: string[] = []
    const wanted: string[] = []
    let expired = 0
    let alreadyAsked = 0
    for (const [purl, entries] of byPurl) {
        if (askedThisProcess.has(purl)) {
            // An earlier source asked, and the server's answer — or its silence — stands for the
            // process. What it answered is handed on under every key this source owns it by, once
            // the write machinery below exists (FLOW 2f).
            count('resolver:already-asked')
            alreadyAsked++
            reusedPurls.push(purl)
            continue
        }
        const keys = new Set(entries.map(it => `${ecosystemOf(it.plugin)}:${it.dep.name}`))
        // Already cached under every key it would fill: phase 3 will hit the cache and never reach
        // a registry, so there is nothing to ask for. `--refresh` wants fresh facts, and the
        // resolver is the cheapest place to get them.
        if (!options.refresh && await allCached(cache, keys)) {
            count('resolver:locally-cached')
            continue
        }
        // An expired entry is asked for like a missing one; counted apart only for the log line.
        if (!options.refresh && await anyExpired(cache, keys)) {
            count('resolver:expired')
            expired++
        }
        wanted.push(purl)
    }
    if (wanted.length > 0) {
        log.info(`Asking the resolver about ${wanted.length} purl(s): `
            + `${wanted.length - expired} not cached${options.refresh ? ' (--refresh)' : ''}, ${expired} expired`
            + `${alreadyAsked ? `; ${alreadyAsked} already asked this run` : ''}`)
    } else {
        log.info(alreadyAsked
            ? `Nothing to resolve in bulk: every dependency is in the local cache or was already asked this run (${alreadyAsked})`
            : 'Nothing to resolve in bulk: every dependency is already in the local cache')
    }
    // Marked before the ask, not after it: whatever the server makes of them, they are not asked again.
    for (const purl of wanted) askedThisProcess.add(purl)

    // FLOW 2c — THE SERVER CALL: resolver/client.ts POSTs these purls to <resolver-url>/resolve, in
    // chunks, all at once, and reads each answer as a stream. Every usable answer is taken and
    // written to the cache the moment its line arrives (FLOW 2d), while the server is still fetching
    // the packages it did not know; the advisory lookups that are worth making follow behind it
    // (FLOW 2e). Waiting for the last chunk first used to put all of that work after the slowest
    // package of the run.
    let resolved = 0
    const taken = new Set<string>()
    type Lookup = {cacheKey: string, advisoryEcosystem: string, lib: LibraryInfo, updatedAt: number}
    const lookups: Lookup[] = []
    const undecidedLookups: Lookup[] = []
    let nextLookup = 0
    const workers = new Set<Promise<void>>()
    let writeFailure: {error: unknown} | undefined

    // FLOW 2d — each usable answer → one cache write per (ecosystem, library) key it belongs to,
    // there and then. `take` runs inside the client's line handler, so the row is written — one
    // autocommit statement in SQLite — before the next line is even parsed: a run killed halfway
    // through the stream keeps every answer that had arrived. For the same reason it must not
    // throw: an exception here would read to the client as a broken stream.
    //
    // Each key gets its own LibraryInfo: two plugins can share a purl and not an advisory
    // ecosystem, so they must not share one object to write vulnerabilities into.
    const take = (purl: string, answer: ResolvedEntry): void => {
        if (taken.has(purl)) return
        taken.add(purl)
        // A `refreshing` package is one the server could not refetch before the deadline, and it
        // carries facts older than this run's cutoff. They are better than nothing — unless the run
        // said `--refresh`, which is exactly a request for nothing older than the run, and the
        // registrar chain gets it.
        const usable = answer.status === 'resolved' || (answer.status === 'refreshing' && !options.refresh)
        if (!usable || !answer.package) return
        resolved++
        const githubToken = !!process.env.GH_TOKEN
        // When the server last confirmed these facts, not when they reached us: a `refreshing`
        // answer is older than the cutoff, so its row is written already expired. This run still
        // uses it, from `libs`; the next run asks the server for it again.
        const updatedAt = confirmedAtMs(answer.package.confirmed_at)
        answeredPurls.set(purl, {pkg: answer.package, updatedAt})
        for (const {plugin, dep} of byPurl.get(purl) ?? []) {
            writeKey(`${ecosystemOf(plugin)}:${dep.name}`, plugin, answer.package, updatedAt, githubToken)
        }
        pump()
    }

    // One cache key's write of an answer, from `take` or from an answer an earlier source took.
    function writeKey(cacheKey: string, plugin: Plugin, pkg: PackageRecord, updatedAt: number, githubToken: boolean): void {
        if (written.has(cacheKey)) return
        written.add(cacheKey)
        const lib = toLibraryInfo(pkg)
        try {
            track(cache.set(cacheKey, lib, updatedAt))
        } catch (error) {
            writeFailure ??= {error}
            return
        }
        // Handed to phase 3 as it is, so the entry written here is not read straight back out of
        // the database a moment later. The `cache.set` above is what makes it durable and what
        // every later run reads.
        libs.set(cacheKey, lib)
        answeredThisProcess.set(cacheKey, {lib, updatedAt})
        queueLookup(cacheKey, plugin, lib, updatedAt, githubToken)
    }

    // An advisory lookup, when phase 3 will read its result: the plugin has a GitHub advisory
    // ecosystem, there is a token, some project of this source without scan findings uses the
    // library, and the object has no advisories yet — an answer reused from an earlier source may
    // have been taken where every project had scan findings, and so never looked up.
    function queueLookup(cacheKey: string, plugin: Plugin, lib: LibraryInfo, updatedAt: number, githubToken: boolean): void {
        const advisoryEcosystem = plugin.checker?.githubSecurityAdvisoryEcosystem
        if (!advisoryEcosystem || !githubToken) return
        if (lib.vulnerabilities !== undefined) return
        if (advisoriesRead.has(cacheKey)) lookups.push({cacheKey, advisoryEcosystem, lib, updatedAt})
        else if (advisoriesUndecided.has(cacheKey)) undecidedLookups.push({cacheKey, advisoryEcosystem, lib, updatedAt})
    }

    // A cache whose `set` is asynchronous still gets its write awaited before the phase ends, and
    // its failure reported the same way as a synchronous one.
    function track(write: void | Promise<void>): void {
        if (!write) return
        const worker: Promise<void> = Promise.resolve(write)
            .catch(error => { writeFailure ??= {error} })
            .finally(() => { workers.delete(worker) })
        workers.add(worker)
    }

    // Up to ADVISORY_LOOKUP_CONCURRENCY workers drain the lookup queue; one that finds it empty ends, and
    // the next answer starts a new one. A worker that ends pumps once more, for a lookup queued in
    // the moment between its last look at the queue and its leaving the set.
    let lookupWorkers = 0
    function pump(): void {
        while (lookupWorkers < ADVISORY_LOOKUP_CONCURRENCY && nextLookup < lookups.length) {
            lookupWorkers++
            const worker: Promise<void> = drain()
                .catch(error => { writeFailure ??= {error} })
                .finally(() => {
                    workers.delete(worker)
                    lookupWorkers--
                    pump()
                })
            workers.add(worker)
        }
    }

    // FLOW 2e — GHSA advisories, per key, and a second write with them filled in: the server returns
    // registry facts only. The registrar path does the same lookup, on the same terms, because a
    // resolved package is a cache hit in phase 3 and a cache hit has never fetched advisories:
    // without it a cold run with GH_TOKEN would empty the vulnerability columns of every project no
    // scanner covered. It is one GraphQL call per cache key, eight at a time, and only for a key
    // phase 3 will read advisories from (`advisoriesRead`). A failed lookup keeps the row already
    // written. The cost of writing first: a run killed between the two writes leaves a row with no
    // advisories, which only matters when no scanner ran.
    async function drain(): Promise<void> {
        while (nextLookup < lookups.length) {
            const {cacheKey, advisoryEcosystem, lib, updatedAt} = lookups[nextLookup++]
            try {
                lib.vulnerabilities = await getVulnerabilitiesFromGithub(advisoryEcosystem, lib.name)
            } catch (e: any) {
                log.warn(`Vulnerability lookup failed for ${lib.name}: ${e.message ?? e}`)
                continue
            }
            // Same `updated_at` as the first write: the advisories are not a reconfirmation of the
            // registry facts.
            await cache.set(cacheKey, lib, updatedAt)
        }
    }

    // FLOW 2f — the purls an earlier source already asked about: never sent again. Under a key the
    // earlier source wrote, its very object is handed on; under a key it did not (the same purl,
    // named differently by this source's parser), the earlier answer is written now, with the
    // `updated_at` the server gave it. Advisories follow the same rule as a fresh answer.
    const hasGithubToken = !!process.env.GH_TOKEN
    for (const purl of reusedPurls) {
        for (const {plugin, dep} of byPurl.get(purl) ?? []) {
            const cacheKey = `${ecosystemOf(plugin)}:${dep.name}`
            if (libs.has(cacheKey)) continue
            const earlier = answeredThisProcess.get(cacheKey)
            if (earlier) {
                libs.set(cacheKey, earlier.lib)
                queueLookup(cacheKey, plugin, earlier.lib, earlier.updatedAt, hasGithubToken)
                continue
            }
            const answer = answeredPurls.get(purl)
            if (answer) writeKey(cacheKey, plugin, answer.pkg, answer.updatedAt, hasGithubToken)
        }
    }
    pump()

    if (wanted.length > 0) {
        const answers = await resolve(config, wanted, log, take)
        // The map holds every answer the stream delivered, so this only catches one `onItem` did
        // not see; `take` ignores a purl it has already had.
        for (const [purl, answer] of answers) take(purl, answer)
    }
    // The phase ends when the stream has AND every write and lookup it started has: phase 3 must
    // not read a key while its advisories are still being added.
    while (workers.size > 0) await Promise.all(workers)

    // FLOW 2g — the lookups held back for projects whose findings were not attached yet. Today's
    // rule, applied once the flags are final: a server answer, or a local scan that produced a
    // report, sets the flag and the lookup is never made; a fallback that found no scanner leaves
    // it unset, and the lookup is made exactly as it would have been without a server. Waiting
    // here costs nothing on the usual path — there is nothing to wait for unless GH_TOKEN is set
    // and some library's advisories are still unknown.
    if (undecidedLookups.length > 0) {
        await timePhase('vuln:server-wait', () => options.vulnerabilitiesReady)
        for (const lookup of undecidedLookups) {
            const readers = advisoriesUndecided.get(lookup.cacheKey) ?? []
            if (lookup.lib.vulnerabilities === undefined && readers.some(it => !it.exactVersionVulnerabilities)) lookups.push(lookup)
        }
        pump()
        while (workers.size > 0) await Promise.all(workers)
    }
    if (writeFailure) throw writeFailure.error
    if (wanted.length === 0) return {written, libs, requested: 0, resolved: 0}
    count('resolver:cache-write', written.size)
    log.info(`Resolver filled ${written.size} cache entries from ${resolved} of ${wanted.length} requested package(s)`)
    return {written, libs, requested: wanted.length, resolved}
}

/**
 * One results subfolder's worth of work: the plugins that run, the files their extractors see,
 * and — for an SBOM source — the SBOMs themselves, in walk order.
 */
export interface PlannedRun {
    /** `trivy` or `syft`; also the subfolder under the results folder. */
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
 * Which sources get a run, and with which plugins: per SBOM producer, the `sbom-*` plugins the
 * source's purl types call for (an explicit `-p` selects the plugins it names instead), into
 * `<producer>/`.
 */
export function planRuns(sources: InputSources, selected: Plugin[], options: AnalyseOptions, resultRoot: string, folders: string[]): PlannedRun[] {
    const runs: PlannedRun[] = []
    const explicit = !!options.plugins?.length
    for (const source of sources.sbom) {
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
            files: source.sboms.map(it => it.file),
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
async function prepareSbomScans(runs: PlannedRun[], options: AnalyseOptions, vulnServer?: VulnServerConfig): Promise<SbomPreparation | undefined> {
    deferSbomFindings(false)
    const sbomRuns = runs.filter(it => it.sboms)
    if (sbomRuns.length === 0) return undefined
    const sbomFiles = sbomRuns.flatMap(it => it.files)
    const hasGithubToken = !!process.env.GH_TOKEN
    const sources = parseVulnSources(options.vulnSource ?? DEFAULT_VULN_SOURCE)
    setVulnSources(sources)
    log.info(`Vulnerability sources: ${describeVulnSources(sources)}`)
    const prescanFiles = () => sbomRuns.flatMap(it => sbomFilesToParse(it.plugins, it.files))

    // The vulnerability server stands in for both local scanners at once, so only when both are
    // selected. Asked first, before the GitHub refresh and the cache load, because nothing has to
    // wait for it: the parser is told to leave the findings to it, and the pipeline awaits it just
    // before the findings are read. Its findings are merged with GitHub's, so they are attached
    // only once the refresh below is done.
    let githubDone: () => void = () => undefined
    const githubReady = new Promise<void>(resolve => { githubDone = resolve })
    let vulnerabilities: Promise<VulnOutcome> | undefined
    if (vulnServer && usesVulnServer(sources)) {
        const targets = await timePhase('vuln:purls', () => collectSbomTargets(sbomRuns, filesForPlugin))
        deferSbomFindings(true)
        vulnerabilities = startServerVulnerabilities(vulnServer, targets, {githubReady, prescanFiles, hasGithubToken})
    }

    // Scanner preflight, before any parsing: the SBOM parsers shell out to Trivy and Grype, and a
    // missing binary used to surface only as a mid-run warning per file — leaving the user with a
    // completed run, empty vulnerability columns and nothing that said so. Run once, say it up
    // front, and never abort: a run without scanners is degraded, not invalid. With a vulnerability
    // server it runs only if the server fails.
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

/** The process-wide cache handle: opened once, checkpointed mid-run, closed once at the end. */
export interface CacheSession {
    cache: Cache
    misses: MissCache
    checkpointIfDue: () => Promise<void>
    /** The teardown write: flushes anything still pending and releases the cache's resources. */
    close: () => Promise<void>
}

async function openCacheSession(useCache: boolean, cutoffMs: number): Promise<CacheSession> {
    const cache: Cache = useCache ? sqliteCacheWithCutoff(cutoffMs) : noCache
    if (useCache) log.info(`Using the local SQLite cache: ${sharedCacheDb().file}`)
    const misses: MissCache = useCache ? missCache : noMissCache
    await timePhase('cache:load', async () => {
        await cache.load()
        misses.load()
    })
    // Mid-run durability only: `cache.write()` is the teardown step and may release the cache's
    // resources, so a checkpoint that called it could leave every later lookup in the run failing
    // — and those failures are swallowed per dependency, so the run would still finish and write
    // CSVs with the enrichment silently missing.
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
 * so a folder of Trivy SBOMs and one of Syft SBOMs can be given in one invocation, or in two.
 * Each SBOM source gets the `sbom-*` plugin CSVs, the scan provenance and the Black Duck-shaped
 * files under `<results>/<producer>/`; anything that is not a CycloneDX SBOM is ignored. A
 * subfolder exists only when its source had input.
 */
export async function analyseFiles(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
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
    if (useCache) log.info(`Cache max age: ${formatDuration(maxAgeSeconds)} (entries written before ${new Date(cutoffMs).toISOString()} are expired)`)

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
    const session = await openCacheSession(useCache, cutoffMs)
    let vulnOutcome: VulnOutcome | undefined
    try {
        for (const run of runs) {
            const analysed = await runAnalysis(run.files, run.plugins, run.folder, options, session, resolver, prep?.vulnerabilities, registries)
            if (run.sboms) {
                // Already settled: `runAnalysis` waited for it before reading any finding.
                vulnOutcome = prep?.vulnerabilities ? await prep.vulnerabilities : undefined
                const preflight = prep?.preflight
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
                        const provenanceFile = await writeScanProvenance(run.folder, prep?.hasGithubToken ?? false, run.sboms, fallback)
                        log.info(`Scan provenance written to ${provenanceFile}`)
                    }
                } catch (e: any) {
                    log.warn(`Could not write scan provenance: ${e?.message ?? e}`)
                }
                writeBlackDuckForSource(run.sboms, analysed, run.folder, run.inputFolder, options)
            }
            log.info(`Results for ${run.source} are written to ${run.folder}`)
        }
    } finally {
        await session.close()
    }

    // Repeated here because the preflight banner is thousands of log lines back by now, and
    // because a CSV is only readable next to the matcher and DB build that produced it.
    const summary = prep?.preflight
        ? scannerSummaryLine(prep.preflight, prep.hasGithubToken)
        : vulnOutcome && vulnSummaryLine(vulnOutcome, prep?.hasGithubToken ?? false)
    if (summary) log[summary.level](summary.text)
    log.info('Done')
    logProfile()
}

/**
 * Runs `plugins` over `files` and writes each plugin's three CSVs into `resultFolder`. The
 * enrichment is shared by every source: this is the one place a dependency is looked up.
 */
export async function runAnalysis(
    files: string[], plugins: Plugin[], resultFolder: string, options: AnalyseOptions, session: CacheSession,
    resolver?: ResolverConfig, vulnerabilities?: Promise<unknown>,
    registries: RegistryFallback = createRegistryFallback(resolveRegistryLimits({env: process.env[REGISTRY_LIMITS_ENV]})),
): Promise<AnalysisResult[]> {
    if (!fs.existsSync(resultFolder)) {
        fs.mkdirSync(resultFolder, {recursive: true})
        log.info(`Creating results dir ${resultFolder}`)
    }
    const progress = new MultiBar({}, Presets.shades_grey)

    // FLOW 1 — parse (see extractProjects above): files → DepinderProject[] per plugin. Nothing leaves the machine yet.
    // Phase 1 — parse. Still one pass per plugin, side by side as before; what changed is that
    // every plugin finishes parsing before any enrichment starts, because a bulk question is only
    // worth asking once it can cover the whole run.
    const pluginProjects: PluginProjects[] = await Promise.all(
        plugins.map(async (plugin): Promise<PluginProjects> => {
            log.info(`Plugin ${plugin.name} starting`)
            const projects: DepinderProject[] = await timePhase(`parse:${plugin.name}`, () =>
                extractProjects(plugin, filesForPlugin(plugin, files)))
            return {plugin, projects}
        }))

    // FLOW 1b — assignPurls (see above): name every dep the way the server expects. Still no network.
    // Phase 1b — the purl for every dependency: the SBOM's own, else the checker's spelling of it.
    const named = assignPurls(pluginProjects)

    // FLOW 2 — bulkResolve (see above): the main flow is local cache → our server → registries. What
    // the cache cannot answer is asked of the server ONCE per purl per process, every chunk at once
    // and bounded by the deadline, with no retries; whatever has no usable answer by then goes to the
    // registrars in phase 3. It only fills the cache (and hands phase 3 what it took).
    // Phase 2 — the bulk resolver, when one is configured. It fills the local cache; it never
    // touches the dependencies, so nothing below can tell where an entry came from.
    const bulk: BulkResolveOutcome = resolver
        ? await timePhase('resolve:bulk', async () => {
            log.info(`Asking the resolver about up to ${named} dependency purls`)
            return bulkResolve(resolver, pluginProjects, session.cache, {refresh: options.refresh, vulnerabilitiesReady: vulnerabilities})
        })
        : {written: new Set<string>(), libs: new Map<string, LibraryInfo>(), requested: 0, resolved: 0}
    const bulkWritten = bulk.written
    if (bulkWritten.size > 0) await session.checkpointIfDue()

    // FLOW 2h — the vulnerability server's answer, asked at the start of the run: phase 3 is the
    // first to read a finding or `exactVersionVulnerabilities`, so this is as late as the wait can
    // go. Usually long settled by now; if the server failed, this is where the local scan it fell
    // back to is waited for.
    if (vulnerabilities) await timePhase('vuln:server-wait', () => vulnerabilities)

    // FLOW 3 — enrich: per dep, cache → miss cache → registry fallback. Whatever phase 2 wrote is a plain cache hit here.
    // Phase 3 — enrichment. The plugins run side by side, each registry behind its ecosystem's
    // limits (`registries`), so a registry that stalls no longer holds the others up. Whatever phase 2 cached is a cache hit here, and never reaches a registry.
    const results = await Promise.all(pluginProjects.map(async ({plugin, projects}): Promise<AnalysisResult | undefined> => {
        // A library the resolver just refreshed counts as refreshed: without this, `--refresh`
        // would discard the answer that was fetched seconds ago and go back to the registry.
        const keyPrefix = `${ecosystemOf(plugin)}:`
        const refreshedLibs = [...bulkWritten].filter(it => it.startsWith(keyPrefix)).map(it => it.slice(keyPrefix.length))
        const inFlight = new Map<string, Promise<LibraryInfo>>()
        const registryType = registryTypeOfPlugin(plugin)

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
                    } else if (await cacheHit(session.cache, cacheKey, dep, options.refresh, refreshedLibs)) {
                        count('cache:hit')
                        lib = await session.cache.get(cacheKey) as LibraryInfo
                    } else if (!options.refresh && session.misses.has(cacheKey)) {
                        // Same outcome as the failed lookup it remembers: the dependency
                        // keeps whatever the parser gave it, untouched.
                        count('cache:known-miss')
                        log.warn(`Skipping ${dep.name}: its registry lookup failed within the last ${MISS_TTL_HOURS}h (--refresh to retry)`)
                        return
                    } else {
                        // An expired entry is a miss like any other; the count only tells them apart.
                        count(!options.refresh && await session.cache.isExpired?.(cacheKey) ? 'cache:expired' : 'cache:miss')
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
                                    fetched = await registries.lookup({type: registryType, name: fallbackLookupName(dep)})
                                } catch (e: any) {
                                    if (!isRateLimit(e)) session.misses.set(cacheKey)
                                    throw e
                                }
                                await attachGithubAdvisories(fetched, plugin)
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
                    logLookupFailure(dep.name, ecosystemOf(plugin), e)
                } finally {
                    depProgressBar.increment()
                    depsWithInfo++
                    log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
                }
            }

            let nextDepIndex = 0
            await Promise.all(Array.from(
                {length: Math.min(registries.packagesAtOnce(registryType), filteredDependencies.length)},
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

        // ══ STOP HERE: everything below is CSV/report writing, untouched by this PR ══
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
                // of support — the same answer the old `moment(undefined)` gave by measuring from now.
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

        const purlType = purlTypeOfPlugin(plugin)
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

