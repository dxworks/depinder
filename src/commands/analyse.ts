import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {purlTypeOfPlugin, sbomFilesFor} from '../plugins/sbom'
import {
    preflightScanners,
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
import {jsonCache} from '../cache/json-cache'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {MultiBar, Presets} from 'cli-progress'
import {walkDir} from '../utils/utils'
import {blacklistedGlobs} from '../utils/blacklist'
import minimatch from 'minimatch'
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
import {SECURITY_CSV_FILE, SECURITY_CSV_HEADERS, SecurityRow, securityRowsForProjects} from '../vuln-sources/security-csv'
import {log} from '../utils/logging'
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
}

/** A factory rather than a single instance, so tests can parse arguments from a clean slate. */
export function createAnalyseCommand(): Command {
    return new Command()
        .name('analyse')
        .argument('[folders...]', 'A list of folders to walk for files')
        // .argument('[depext-files...]', 'A list of files to parse for dependency information')
        // Both value-taking options need a <value> placeholder: without one Commander registers
        // them as booleans, so `-r out` set `{R: true}` and left `out` to be walked as another
        // folder, and `--plugins` never reached getPluginsFromNames.
        .option('-r, --results <folder>', 'The results folder', 'results')
        .option('--refresh', 'Refresh the cache', false)
        .option('-p, --plugins <plugins...>', 'A list of plugins')
        .option('--vuln-source <sources>',
            'Vulnerability sources for the SBOM route: a comma-separated list of trivy, grype, github, all',
            DEFAULT_VULN_SOURCE)
        .option('--github-token-file <file>',
            'Dotenv-style file holding GH_TOKEN_1, GH_TOKEN_2, ... for --vuln-source github',
            DEFAULT_TOKEN_FILE)
        .option('--github-max-age <hours>',
            'Re-download a cached ecosystem\'s GitHub advisories when they are older than this',
            String(DEFAULT_MAX_AGE_HOURS))
        .action(analyseFiles)
}

export const analyseCommand = createAnalyseCommand()


function extractLicenses(dep: DepinderDependency) {
    return dep.libraryInfo?.licenses?.map(it => {
        if (typeof it === 'string') return it.substring(0, 100); else return JSON.stringify(it)
    })
}

/**
 * RFC 4180: a cell containing a comma, a quote or a newline must be quoted, and embedded quotes
 * doubled. Versions carry commas in the wild — Maven range strings such as `[4.1,4.2000)` — and an
 * unquoted one splits into two cells, shifting every column after it for that row.
 */
function csvCell(value: unknown): string {
    const text = value === undefined || value === null ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export function csvRow(cells: unknown[]): string {
    return cells.map(csvCell).join(',')
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
        log.warn('Mongo cache is not running, using in-memory cache')
        return jsonCache
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

export async function analyseFiles(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    const resultFolder = options.results || 'results'
    if (!fs.existsSync(path.resolve(process.cwd(), resultFolder))) {
        fs.mkdirSync(path.resolve(process.cwd(), resultFolder), {recursive: true})
        log.info('Creating results dir')
    }
    const allFiles = folders.flatMap(it => walkDir(it))

    const selectedPlugins = getPluginsFromNames(options.plugins)

    // Scanner preflight, before any parsing: the SBOM parsers shell out to Trivy and Grype, and a
    // missing binary used to surface only as a mid-run warning per file — leaving the user with a
    // completed run, empty vulnerability columns and nothing that said so. Run once, say it up
    // front, and never abort: a run without scanners is degraded, not invalid.
    const sbomFiles = sbomFilesFor(selectedPlugins, allFiles)
    const hasGithubToken = !!process.env.GH_TOKEN
    const sources = parseVulnSources(options.vulnSource ?? DEFAULT_VULN_SOURCE)
    setVulnSources(sources)
    if (sbomFiles.length > 0) log.info(`Vulnerability sources: ${describeVulnSources(sources)}`)

    const runsLocalScanners = sources.trivy || sources.grype
    const preflight = sbomFiles.length > 0 && runsLocalScanners ? await preflightScanners() : undefined
    if (preflight) {
        for (const message of scannerPreflightMessages(preflight, hasGithubToken)) log[message.level](message.text)
    }

    // The GitHub cache is refreshed before any parsing, and only for the ecosystems these SBOMs
    // actually contain — a Ruby project never downloads npm's 7,000 advisories. A refresh failure
    // is a warning: whatever is already cached still matches.
    if (sbomFiles.length > 0 && sources.github) {
        const ecosystems = ecosystemsInSboms(sbomFiles)
        log.info(`GitHub advisory ecosystems in these SBOMs: ${ecosystems.join(', ') || 'none'}`)
        try {
            const report = await refreshEcosystems(ecosystems, Number(options.githubMaxAge ?? DEFAULT_MAX_AGE_HOURS), {
                tokenFile: options.githubTokenFile,
            })
            if (!report) log.info('GitHub advisory cache is up to date; nothing to download')
        } catch (e: any) {
            log.warn(`GitHub advisory refresh skipped: ${e?.message ?? e}`)
        }
    }

    const securityRows: SecurityRow[] = []

    for (const plugin of selectedPlugins) {
        log.info(`Plugin ${plugin.name} starting`)

        const cache: Cache = useCache ? chooseCacheOption() : noCache
        await cache.load()
        const refreshedLibs = [] as string[]
        const inFlight = new Map<string, Promise<LibraryInfo>>()
        let newLookups = 0

        const files = allFiles
            .filter(it => plugin.extractor.filter ? plugin.extractor.filter(it) : true)
            .filter(it => plugin.extractor.files
                .some(pattern => minimatch(it, pattern, {matchBase: true}))
            )

        const projects: DepinderProject[] = await extractProjects(plugin, files)

        const multiProgressBar = new MultiBar({}, Presets.shades_grey)

        const projectsBar = multiProgressBar.create(projects.length, 0, {name: 'Projects', state: 'Analysing'})


        for (const project of projects) {
            log.info(`Plugin ${plugin.name} analyzing project ${project.name}@${project.version}`)
            const dependencies = Object.values(project.dependencies)
            const filteredDependencies = dependencies.filter(it => !blacklistedGlobs.some(glob => minimatch(it.name, glob)))
            const depProgressBar = multiProgressBar.create(filteredDependencies.length, 0, {
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
                    if (await cacheHit(cache, cacheKey, dep, options.refresh, refreshedLibs)) {
                        lib = await cache.get(cacheKey) as LibraryInfo
                    } else {
                        // log.info(`Getting remote information on ${dep.name}`)
                        let fetch = inFlight.get(cacheKey)
                        if (!fetch) {
                            fetch = (async () => {
                                const fetched = await retrieveWithRetry(plugin, dep.name)
                                if (plugin.checker?.githubSecurityAdvisoryEcosystem && process.env.GH_TOKEN) {
                                    // A failed advisory lookup must not discard the registry data
                                    // already fetched — degrade to no vulnerabilities instead.
                                    try {
                                        fetched.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, fetched.name)
                                    } catch (e: any) {
                                        log.warn(`Vulnerability lookup failed for ${fetched.name}: ${e.message ?? e}`)
                                    }
                                }
                                await cache.set(cacheKey, fetched)
                                if (options.refresh) refreshedLibs.push(dep.name)
                                if (++newLookups % 50 === 0) await cache.write()
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
                    log.warn(`Exception getting remote info for ${dep.name}`)
                    log.error(e)
                }
                depProgressBar.increment()
                depsWithInfo++
                log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
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
        projectsBar.stop()

        multiProgressBar.stop()

        await cache.write()

        const allLibsInfo = projects.flatMap(proj => Object.values(proj.dependencies).map(dep => dep.libraryInfo))
            .filter(it => it !== undefined && it != null).map(it => it as LibraryInfo)

        const allLicenses = _.groupBy(allLibsInfo, licenseOf)

        const licensesHeader = 'License,Libraries,Library Names\n'
        fs.writeFileSync(path.resolve(process.cwd(), resultFolder, `${plugin.name}-licenses.csv`),
            licensesHeader + Object.keys(allLicenses).map(license =>
                csvRow([license, allLicenses[license].length, allLicenses[license].map(it => it.name).join(', ')])
            ).join('\n'))

        const header = 'Project Path,Project,Library,Used Version,Latest Version,Used Version Release Date,Latest Version Release Date,Latest-Used,Now-Used,Now-latest,Vulnerabilities,Vulnerability Details,DirectDependency,Type,Licenses\n'
        fs.writeFileSync(path.resolve(process.cwd(), resultFolder, `${plugin.name}-libs.csv`), header + projects.flatMap(proj =>
            Object.values(proj.dependencies).map(dep => convertDepToRow(proj, dep))).join('\n'))


        securityRows.push(...securityRowsForProjects(projects, purlTypeOfPlugin(plugin) ?? ecosystemOf(plugin)))

        const projectStatsHeader = 'Project Path,Project,Direct Deps,Indirect Deps,Direct Outdated Deps, Direct Outdated %,Indirect Outdated Deps, Indirect Outdated %, Direct Vulnerable Deps, Indirect Vulnerable Deps, Direct Out of Support, Indirect Out of Support\n'
        fs.writeFileSync(path.resolve(process.cwd(), resultFolder, `${plugin.name}-project-stats.csv`), projectStatsHeader + projects.map(proj => {
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
    }

    // One security CSV for the whole run, not one per plugin: a finding is identified by
    // (component, advisory, project), and which depinder plugin happened to enrich the component
    // is not part of that identity.
    fs.writeFileSync(path.resolve(process.cwd(), resultFolder, SECURITY_CSV_FILE),
        [csvRow([...SECURITY_CSV_HEADERS]), ...securityRows.map(row => csvRow(SECURITY_CSV_HEADERS.map(it => row[it])))].join('\n'))
    log.info(`${securityRows.length} security finding row(s) written to ${SECURITY_CSV_FILE}`)

    if (preflight) {
        // Repeated here because the preflight banner is thousands of log lines back by now, and
        // because a CSV is only readable next to the matcher and DB build that produced it.
        const summary = scannerSummaryLine(preflight, hasGithubToken)
        log[summary.level](summary.text)
        try {
            const provenanceFile = await writeScanProvenance(path.resolve(process.cwd(), resultFolder), hasGithubToken)
            log.info(`Scan provenance written to ${provenanceFile}`)
        } catch (e: any) {
            log.warn(`Could not write scan provenance: ${e?.message ?? e}`)
        }
    }

    log.info(`Results are written to ${path.resolve(process.cwd(), resultFolder)}`)
    log.info('Done')
}

interface DependencyInfo extends DepinderDependency {
    direct: boolean
    latest_used: number
    now_used: number
    now_latest: number
}

