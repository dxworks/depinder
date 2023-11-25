import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {log} from '@dxworks/cli-common'
import {LibraryInfo} from '../extension-points/registrar'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Range} from 'semver'
import _ from 'lodash'
import spdxCorrect from 'spdx-correct'
import moment from 'moment'
import {Plugin} from '../extension-points/plugin'
import {Cache, noCache} from '../cache/cache'
import {getMongoDockerContainerStatus} from './cache'
import {jsonCacheLibrary, jsonCacheProject, jsonCacheSystem} from '../cache/json-cache'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {MultiBar, Presets} from 'cli-progress'
import {walkDir} from '../utils/utils'
import {blacklistedGlobs} from '../utils/blacklist'
import minimatch from 'minimatch'
import {mongoCacheLibrary, mongoCacheProject, mongoCacheSystem} from '../cache/mongo-cache'
import {Project} from '../../core/project'
// import {defaultPlugins} from '../extension-points/plugin-loader'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const licenseIds = require('spdx-license-ids/')

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100

export interface AnalyseOptions {
    plugins?: string[]
    results: string
    refresh: boolean
}

interface DependencyInfo extends DepinderDependency {
    direct: boolean
    latest_used: number
    now_used: number
    now_latest: number
}

interface ProjectLibs {
    path: string,
    project: string,
    name: string,
    version: string,
    latestVersion: string | undefined,
    usedVersionReleaseDate: string,
    latestVersionReleaseDate: string,
    latestUsed: number,
    nowUsed: number,
    nowLatest: number,
    vulnerabilities: number | undefined,
    vulnerabilityDetails: string | undefined,
    directDependency: boolean,
    type: string | undefined,
    licenses: string | undefined,
}

export const analyseCommand = new Command()
    .name('analyse')
    .argument('[folders...]', 'A list of folders to walk for files')
    // .argument('[depext-files...]', 'A list of files to parse for dependency information')
    .option('--results, -r', 'The results folder', 'results')
    .option('--refresh', 'Refresh the cache', false)
    .option('--plugins, -p [plugins...]', 'A list of plugins')
    .action(analyseFilesToCache)
    .action(saveToCsv)

const outOfSupportThreshold = 24
const outdatedThreshold = 15
const dateFormat = 'MMM YYYY'

function chooseLibsCacheOption(): Cache {

    if (getMongoDockerContainerStatus() != 'running') {
        log.warn('Mongo cache is not running, using in-memory cache')
        return jsonCacheLibrary
    }
    log.info('Mongo cache is up and running, using Mongo cache')
    return mongoCacheLibrary
}

function chooseProjectsCacheOption(): Cache {

    if (getMongoDockerContainerStatus() != 'running') {
        log.warn('Mongo cache is not running, using in-memory cache')
        return jsonCacheProject
    }
    log.info('Mongo cache is up and running, using Mongo cache')
    return mongoCacheProject
}

function chooseSystemsCacheOption(): Cache {

    if (getMongoDockerContainerStatus() != 'running') {
        log.warn('Mongo cache is not running, using in-memory cache')
        return jsonCacheSystem
    }
    log.info('Mongo cache is up and running, using Mongo cache')
    return mongoCacheSystem
}

function extractLicenses(dep: DepinderDependency) {
    return dep.libraryInfo?.licenses?.map(it => {
        if (typeof it === 'string') return it.substring(0, 100); else return JSON.stringify(it)
    })
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

function extractProjectStats(proj: DepinderProject): Project {
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

    const directOutdated = directDeps.filter(dep => dep.latest_used > outdatedThreshold)
    const directOutDatedPercent = directDeps.length == 0 ? 0 : directOutdated.length / directDeps.length * 100
    const indirectOutdated = indirectDeps.filter(dep => dep.latest_used > outdatedThreshold)
    const indirectOutDatedPercent = indirectDeps.length == 0 ? 0 : indirectOutdated.length / indirectDeps.length * 100
    const directVulnerable = directDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0)
    const indirectVulnerable = indirectDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0)

    const directOutOfSupport = directDeps.filter(dep => dep.now_latest > outOfSupportThreshold)
    const indirectOutOfSupport = indirectDeps.filter(dep => dep.now_latest > outOfSupportThreshold)

    return {
        directDeps: directDeps.length,
        directOutOfSupport: directOutOfSupport.length,
        directOutdatedDeps: directOutdated.length,
        directOutdatedDepsPercentage: directOutDatedPercent,
        directVulnerableDeps: directVulnerable.length,
        indirectDeps: indirectDeps.length,
        indirectOutOfSupport: indirectOutOfSupport.length,
        indirectOutdatedDeps: indirectOutdated.length,
        indirectOutdatedDepsPercentage: indirectOutDatedPercent,
        indirectVulnerableDeps: indirectVulnerable.length,
        name: proj.name,
        projectPath: proj.path,
    } as Project
}

function extractProjectLibs(proj: DepinderProject, dep: DepinderDependency): ProjectLibs {
    const latestVersion = dep.libraryInfo?.versions.find(it => it.latest)
    const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim())
    const latestVersionMoment = moment(latestVersion?.timestamp)
    const currentVersionMoment = moment(currentVersion?.timestamp)
    const now = moment()

    const vulnerabilities = dep.vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n')
    const directDep: boolean = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`))

    return {
        path: proj.path,
        project: proj.name,
        name: dep.name,
        version: dep.version,
        latestVersion: latestVersion?.version,
        usedVersionReleaseDate: currentVersionMoment?.format(dateFormat),
        latestVersionReleaseDate: latestVersionMoment?.format(dateFormat),
        latestUsed: latestVersionMoment?.diff(currentVersionMoment, 'months'),
        nowUsed: now?.diff(currentVersionMoment, 'months'),
        nowLatest: now?.diff(latestVersionMoment, 'months'),
        vulnerabilities: dep.vulnerabilities?.length,
        vulnerabilityDetails: vulnerabilities,
        directDependency: directDep,
        type: dep.type,
        licenses: extractLicenses(dep)?.join(','),
    } as ProjectLibs
}

async function getLib(cache: Cache, plugin: Plugin, dep: DepinderDependency, options: AnalyseOptions, refreshedLibs: any[]) {
    let lib
    if (await cacheHit(cache, plugin, dep, options.refresh, refreshedLibs)) {
        lib = await cache.get(`${plugin.name}:${dep.name}`) as LibraryInfo
    } else {
        lib = await plugin.registrar.retrieve(dep.name)
        if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
            // log.info(`Getting vulnerabilities for ${lib.name}`)
            lib.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name)
        }
        await cache.set(`${plugin.name}:${dep.name}`, lib)
        if (options.refresh) refreshedLibs.push(dep.name)
    }

    return lib
}

async function cacheHit(cache: Cache, plugin: Plugin, dep: DepinderDependency, refresh: boolean, refreshedLibs: any[]) {
    if (refresh && !refreshedLibs.includes(dep.name)) {
        return false
    }
    return cache.has(`${plugin.name}:${dep.name}`)
}

async function processProjects(projects: DepinderProject[], plugin: Plugin, cache: Cache, refreshedLibs: string[], options: AnalyseOptions, cacheProjects: Cache) {
    const multiProgressBar = new MultiBar({}, Presets.shades_grey)

    const projectsBar = multiProgressBar.create(projects.length, 0, {name: 'Projects', state: 'Analysing'})


    for (const project of projects) {
        await processSingleProject(project, plugin, cache, refreshedLibs, options, cacheProjects)
        projectsBar.increment()
    }

    projectsBar.stop()

    await cacheProjects.write()
    await cache.write()
}

async function processSingleProject(project: DepinderProject, plugin: any, cache: Cache, refreshedLibs: string[], options: AnalyseOptions, cacheProjects: Cache): Promise<void> {
    log.info(`Plugin ${plugin.name} analyzing project ${project.name}@${project.version}`)
    const dependencies = Object.values(project.dependencies)
    const filteredDependencies = dependencies.filter(it => !blacklistedGlobs.some(glob => minimatch(it.name, glob)))

    const multiProgressBar = new MultiBar({}, Presets.shades_grey)

    const depProgressBar = multiProgressBar.create(filteredDependencies.length, 0, {
        name: 'Deps',
        state: 'Analysing deps',
    })
    let depsWithInfo = 0

    for (const dep of filteredDependencies) {
        try {
            dep.libraryInfo = await getLib(
                cache,
                plugin,
                dep,
                options,
                refreshedLibs
            )
        } catch (e: any) {
            log.warn(`Exception getting remote info for ${dep.name}`)
            log.error(e)
        }
        depProgressBar.increment()
        depsWithInfo++
        log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
    }

    depProgressBar.stop()

    const projectInfo = extractProjectStats(project)

    log.info('Project data saving in mongo db...')

    //todo save project info separate, stats + dependencies
    await cacheProjects.set(`${project.name}@${project.version}`, {
        name: project.name,
        projectPath: project.path,
        directDeps: projectInfo.directDeps,
        indirectDeps: projectInfo.indirectDeps,
        directOutdatedDeps: projectInfo.directOutdatedDeps,
        directOutdatedDepsPercentage: projectInfo.directOutdatedDepsPercentage,
        indirectOutdatedDeps: projectInfo.indirectOutdatedDeps,
        indirectOutdatedDepsPercentage: projectInfo.indirectOutdatedDepsPercentage,
        directVulnerableDeps: projectInfo.directVulnerableDeps,
        indirectVulnerableDeps: projectInfo.indirectVulnerableDeps,
        directOutOfSupport: projectInfo.directOutOfSupport,
        indirectOutOfSupport: projectInfo.indirectOutOfSupport,
    })

    const outOfSupportDate = moment().subtract(outOfSupportThreshold, 'months').format(dateFormat)
    const outdatedDate = moment().subtract(outdatedThreshold, 'months').format(dateFormat)

    await cacheProjects.set(`${project.name}@${project.version}`, {
        dependencies: Object.values(project.dependencies).map(dep => {
            const libraryInfo = dep.libraryInfo?.versions.find(version => dep.version === version.version)
            return {
                _id: `${plugin.name}:${dep.name}`,
                name: dep.name,
                version: dep.version,
                type: dep.type,
                directDep: !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${project.name}@${project.version}`)),
                requestedBy:dep.requestedBy.filter((value, index, array) => array.indexOf(value) === index),
                vulnerabilities: (dep.libraryInfo?.vulnerabilities ?? []).length > 0,
                outOfSupport: libraryInfo !== undefined ? new Date(libraryInfo.timestamp) < new Date(outOfSupportDate) : undefined,
                outdated: libraryInfo !== undefined ? new Date(libraryInfo.timestamp) < new Date(outdatedDate) : undefined,
            }
        }),
    })

    log.info('Project data saving in mongo db done!')
}

async function processSystem(projects: DepinderProject[], useCache: boolean) {
    const cache: Cache = useCache ? chooseSystemsCacheOption() : noCache

    await cache.load()

    const strings: string[] = []

    for (const project of projects) {
        strings.push(project.path)
    }


    let systemName = strings[0]

    for (let i = 1; i < strings.length; i++) {
        while (strings[i].indexOf(systemName) !== 0) {
            systemName = systemName.substring(0, systemName.length - 1)
            if (systemName === '') return ''
        }
    }

    console.log('system name' + systemName)

    await cache.set(systemName, {
        name: systemName,
        projectPath: systemName,
        projects: projects.map(it => `${it.name}@${it.version}`),
    })
}

function filterFilesForPlugin(allFiles: string[], plugin: any): string[] {
    return allFiles.filter(file => {
        if (plugin.extractor.filter && !plugin.extractor.filter(file)) {
            return false
        }
        return plugin.extractor.files.some((pattern: string) =>
            minimatch(file, pattern, {matchBase: true})
        )
    })
}

export async function analyseFilesToCache(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    const allFiles = folders.flatMap(walkDir)
    const selectedPlugins = getPluginsFromNames(options.plugins)

    const cache: Cache = useCache ? chooseLibsCacheOption() : noCache
    const cacheProjects = useCache ? chooseProjectsCacheOption() : noCache

    await cache.load()

    const allProjects = [] as DepinderProject[]

    for (const plugin of selectedPlugins) {
        log.info(`Plugin ${plugin.name} starting`)
        const refreshedLibs: string[] = []

        const files = filterFilesForPlugin(allFiles, plugin)
        const projects: DepinderProject[] = await extractProjects(plugin, files)

        allProjects.push(...projects)

        await processProjects(projects, plugin, cache, refreshedLibs, options, cacheProjects)
    }

    console.log('Projects in the system:', allProjects.length)

    await processSystem(allProjects, useCache)

    log.info('Done')
}

export async function saveToCsv(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    const resultFolder = options.results || 'results'
    if (!fs.existsSync(path.resolve(process.cwd(), resultFolder))) {
        fs.mkdirSync(path.resolve(process.cwd(), resultFolder), {recursive: true})
        log.info('Creating results dir')
    }

    const refreshedLibs = [] as string[]

    const selectedPlugins = getPluginsFromNames(options.plugins)

    const allFiles = folders.flatMap(it => walkDir(it))

    const cache: Cache = useCache ? chooseLibsCacheOption() : noCache
    await cache.load()

    for (const plugin of selectedPlugins) {
        const files = allFiles
            .filter(it => plugin.extractor.filter ? plugin.extractor.filter(it) : true)
            .filter(it => plugin.extractor.files
                .some(pattern => minimatch(it, pattern, {matchBase: true}))
            )

        const projects: DepinderProject[] = await extractProjects(plugin, files)

        for (const project of projects) {
            const dependencies = Object.values(project.dependencies)
            const filteredDependencies = dependencies.filter(it => !blacklistedGlobs.some(glob => minimatch(it.name, glob)))

            await extractProjects(plugin, files)

            for (const dep of filteredDependencies) {
                try {
                    const lib = await getLib(
                        cache,
                        plugin,
                        dep,
                        options,
                        refreshedLibs
                    )
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

            }
        }


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
            Object.values(proj.dependencies).map(dep => {

                 const data = extractProjectLibs(proj, dep)

                return `${data.path},${data.name},${data.name},${data.version},${data.latestVersion},${data.usedVersionReleaseDate},${data.latestVersionReleaseDate},${data.latestUsed},${data.nowUsed},${data.nowLatest},"${data.vulnerabilities}",${data.vulnerabilityDetails},${data.directDependency},"${data.type}","${data.licenses}"`
            })).join('\n'))

        const cacheProjects = useCache ? chooseProjectsCacheOption() : noCache
        await cacheProjects.load()

        const projectStatsHeader = 'Project Path,Project,Direct Deps,Indirect Deps,Direct Outdated Deps, Direct Outdated %,Indirect Outdated Deps, Indirect Outdated %, Direct Vulnerable Deps, Indirect Vulnerable Deps, Direct Out of Support, Indirect Out of Support\n'
        fs.writeFileSync(path.resolve(process.cwd(), resultFolder, `${plugin.name}-project-stats.csv`), projectStatsHeader + projects.map(proj => {
            const projectInfo = extractProjectStats(proj)

            return `${projectInfo.projectPath},${projectInfo.name},${projectInfo.directDeps},${projectInfo.indirectDeps},${projectInfo.directOutdatedDeps},${projectInfo.directOutdatedDepsPercentage},${projectInfo.indirectOutdatedDeps},${projectInfo.indirectOutdatedDepsPercentage},${projectInfo.directVulnerableDeps},${projectInfo.indirectVulnerableDeps},${projectInfo.directOutOfSupport},${projectInfo.indirectOutOfSupport}`
        }).join('\n'))
    }

    log.info(`Results are written to ${path.resolve(process.cwd(), resultFolder)}`)
    log.info('Done')
}