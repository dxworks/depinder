import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {LibraryInfo} from '../extension-points/registrar'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Range} from 'semver'
import _ from 'lodash'
import spdxCorrect from 'spdx-correct'
import moment from 'moment'
import {Plugin} from '../extension-points/plugin'
import {Cache, noCache} from '../cache/cache'
import {getMongoDockerContainerStatus} from './cache'
import {jsonCache} from '../cache/json-cache'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {MultiBar, Presets} from 'cli-progress'
import {walkDir} from '../utils/utils'
import {blacklistedGlobs} from '../utils/blacklist'
import { minimatch } from 'minimatch'
import {mongoCache} from '../cache/mongo-cache'
import {log} from '../utils/logging'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const licenseIds = require('spdx-license-ids/')

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100

export interface AnalyseOptions {
    plugins?: string[]
    results: string
    refresh: boolean
}

export const analyseCommand = new Command()
    .name('analyse')
    .argument('[folders...]', 'A list of folders to walk for files')
    // .argument('[depext-files...]', 'A list of files to parse for dependency information')
    .option('-r, --results <folder>', 'The results folder', 'results')
    .option('--refresh', 'Refresh the cache', false)
    .option('-p, --plugins [plugins...]', 'A list of plugins')
    .action(analyseFiles)


function extractLicenses(dep: DepinderDependency) {
    return dep.libraryInfo?.licenses?.map(it => {
        if (typeof it === 'string') return it.substring(0, 100); else return JSON.stringify(it)
    })
}

function convertDepToRow(proj: DepinderProject, dep: DepinderDependency): string {
    const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
    const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim())
    const latestVersionMoment = moment(latestVersion?.timestamp)
    const currentVersionMoment = moment(currentVersion?.timestamp)
    const now = moment()

    const dateFormat = 'MMM YYYY'
    const vulnerabilities = dep.vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n')
    const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))
    return `${proj.path},${proj.name},${dep.name},${dep.version},${latestVersion?.version},${currentVersionMoment?.format(dateFormat)},${latestVersionMoment?.format(dateFormat)},${latestVersionMoment?.diff(currentVersionMoment, 'months')},${now?.diff(currentVersionMoment, 'months')},${now?.diff(latestVersionMoment, 'months')},${dep.vulnerabilities?.length},"${vulnerabilities}",${directDep},${dep.type},"${extractLicenses(dep)}"`
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

function chooseCacheOption(): Cache {

    if (getMongoDockerContainerStatus() != 'running') {
        log.warn('Mongo cache is not running, using in-memory cache')
        return jsonCache
    }
    log.info('Mongo cache is up and running, using Mongo cache')
    return mongoCache
}

async function cacheHit(cache: Cache, plugin: Plugin, dep: DepinderDependency, refresh: boolean, refreshedLibs: any[]) {
    if (refresh && !refreshedLibs.includes(dep.name)) {
        return false
    }
    return cache.has(`${plugin.name}:${dep.name}`)
}

export async function analyseFiles(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    const resultFolder = options.results || 'results'
    if (!fs.existsSync(path.resolve(process.cwd(), resultFolder))) {
        fs.mkdirSync(path.resolve(process.cwd(), resultFolder), {recursive: true})
        log.info('Creating results dir')
    }
    const allFiles = folders.flatMap(it => walkDir(it))

    const selectedPlugins = getPluginsFromNames(options.plugins)

    for (const plugin of selectedPlugins) {
        log.info(`Plugin ${plugin.name} starting`)

        const cache: Cache = useCache ? chooseCacheOption() : noCache
        await cache.load()
        const refreshedLibs = [] as string[]

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

            for (const dep of filteredDependencies) {
                try {
                    let lib
                    if (await cacheHit(cache, plugin, dep, options.refresh, refreshedLibs)) {
                        lib = await cache.get(`${plugin.name}:${dep.name}`) as LibraryInfo
                    } else {
                        // log.info(`Getting remote information on ${dep.name}`)

                        lib = await plugin.registrar.retrieve(dep.name)
                        if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
                            // log.info(`Getting vulnerabilities for ${lib.name}`)
                            lib.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name)
                        }
                        await cache.set(`${plugin.name}:${dep.name}`, lib)
                        if (options.refresh) refreshedLibs.push(dep.name)
                    }
                    dep.libraryInfo = lib
                    const thisVersionVulnerabilities = lib.vulnerabilities?.filter((it: Vulnerability) => {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            const range = new Range(it.vulnerableRange?.replaceAll(',', ' ') ?? '')
                            return range.test(dep.version)
                        } catch (e: any) {
                            // log.warn(`Vulnerable range unknown: ${it.vulnerableRange}`)
                            return false
                        }
                    })
                    dep.vulnerabilities = thisVersionVulnerabilities || []
                } catch (e: any) {
                    log.warn(`Exception getting remote info for ${dep.name}`)
                    log.error(e)
                }
                depProgressBar.increment()
                depsWithInfo++
                log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
            }
            depProgressBar.stop()
            projectsBar.increment()
        }
        projectsBar.stop()

        multiProgressBar.stop()

        await cache.write()

        const allLibsInfo = projects.flatMap(proj => Object.values(proj.dependencies).map(dep => dep.libraryInfo))
            .filter(it => it !== undefined && it != null).map(it => it as LibraryInfo)

        const allLicenses = _.groupBy(allLibsInfo, (lib: LibraryInfo) => {
            const license: string | undefined = lib.versions.flatMap(it => it.licenses).find(() => true)
            if (!license || typeof license !== 'string')
                return 'unknown'
            if (!licenseIds.includes(license))
                return spdxCorrect(license || 'unknown') || 'unknown'
            return license
        })

        fs.writeFileSync(path.resolve(process.cwd(), resultFolder, `${plugin.name}-licenses.csv`), Object.keys(allLicenses).map(l => {
            return `${l},${allLicenses[l].length},${allLicenses[l].map((it: any) => it.name)}`
        }).join('\n'))

        const header = 'Project Path,Project,Library,Used Version,Latest Version,Used Version Release Date,Latest Version Release Date,Latest-Used,Now-Used,Now-latest,Vulnerabilities,Vulnerability Details,DirectDependency,Type,Licenses\n'
        fs.writeFileSync(path.resolve(process.cwd(), resultFolder, `${plugin.name}-libs.csv`), header + projects.flatMap(proj =>
            Object.values(proj.dependencies).map(dep => convertDepToRow(proj, dep))).join('\n'))


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

            return `${proj.path},${proj.name},${directDeps.length},${indirectDeps.length},${directOutdated.length},${directOutDatedPercent},${indirectOutdated.length},${indirectOutDatedPercent},${directVulnerable.length},${indirectVulnerable.length},${directOutOfSupport.length},${indirectOutOfSupport.length}`
        }).join('\n'))
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

