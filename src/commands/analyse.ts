import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {getPluginsFromNames} from '../plugins'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Range} from 'semver'
import _ from 'lodash'
import spdxCorrect from 'spdx-correct'
import moment from 'moment'
import {Plugin} from '../extension-points/plugin'
import {Cache, noCache} from '../cache/cache'
import {getMongoDockerContainerStatus} from './cache'
import {jsonCacheLibrary, jsonCacheProject, jsonCacheSystem} from '../cache/json-cache'
import {MultiBar, Presets} from 'cli-progress'
import {walkDir} from '../utils/utils'
import {blacklistedGlobs} from '../utils/blacklist'
import minimatch from 'minimatch'
import {log} from '../utils/logging'
import {mongoCacheLibrary, mongoCacheProject, mongoCacheSystem} from '../cache/mongo-cache'
import {Project} from '../../core/project'
import {Vulnerability} from '../../core/vulnerability-checker'
import {LibraryInfo} from '../../core/library'
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
    .action((folders: string[], options: AnalyseOptions) => {
        // Call analyseFilesToCache and handle the result, but do not return anything.
        analyseFilesToCache(folders, options).then((result) => {
            // Handle the result as needed, e.g., log it or process it
            console.log(result)
        }).catch(error => {
            // Handle any errors
            console.error(error)
        })
        // No return statement here
    })
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
        return it.substring(0, 100)
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

            if (proj.name === undefined) {
                log.warn(`Project name is undefined for ${JSON.stringify(context)}`)
                proj.name = proj.path
                continue
            }
            if (context.manifestFile !== undefined) {
                proj.manifestFile = context.manifestFile
            }
            if (context.lockFile !== undefined) {
                proj.lockFile = context.lockFile
            }

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

    console.log('manifestFile', proj.manifestFile, proj.manifestFile !== undefined)
    console.log('lockFile', proj.lockFile, proj.lockFile !== undefined)

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
        manifestFile: proj.manifestFile,
        lockFile: proj.lockFile,
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
        log.info(`Cache hit for ${dep.name}`)
        lib = await cache.get?.(`${plugin.name}:${dep.name}`) as LibraryInfo
    } else {
        log.info(`Refreshing remote info for ${dep.name}`)
        lib = await plugin.registrar.retrieve(dep.name)
        if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
            lib.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name)
        }

        await cache.load()
        await cache.set?.(`${plugin.name}:${dep.name}`, lib)
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
    const newProjectIds: string[] = []
    const multiProgressBar = new MultiBar({}, Presets.shades_grey)

    const projectsBar = multiProgressBar.create(projects.length, 0, {name: 'Projects', state: 'Analysing'})

    for (const project of projects) {
        newProjectIds.push(await processSingleProject(project, plugin, cache, refreshedLibs, options, cacheProjects))
        projectsBar.increment()
    }

    projectsBar.stop()

    await cacheProjects.load()
    await cacheProjects.write()

    await cache.load()
    await cache.write()

    return newProjectIds
}

async function processSingleProject(project: DepinderProject, plugin: any, cache: Cache, refreshedLibs: string[], options: AnalyseOptions, cacheProjects: Cache): Promise<string> {
    log.info(`Plugin ${plugin.name} analyzing project ${project.name}@${project.version}`)
    const dependencies = Object.values(project.dependencies)
    const filteredDependencies = options.refresh ? dependencies.filter(it => !blacklistedGlobs.some(glob => minimatch(it.name, glob))) : []

    const multiProgressBar = new MultiBar({}, Presets.shades_grey)

    const depProgressBar = multiProgressBar.create(filteredDependencies.length, 0, {
        name: 'Deps',
        state: 'Analysing deps',
    })
    let depsWithInfo = 0

    console.time('Execution Time');

    const batchSize = 10;
    for (let i = 0; i < filteredDependencies.length; i += batchSize) {
        const batch = filteredDependencies.slice(i, i + batchSize);
        const promises = batch.map(dep =>
            getLib(cache, plugin, dep, options, refreshedLibs)
                .then(libraryInfo => {
                    dep.libraryInfo = libraryInfo;
                    log.info(`Got remote information on ${dep.name} (${i + batch.indexOf(dep) + 1}/${filteredDependencies.length})`);
                })
                .catch(e => {
                    log.warn(`Exception getting remote info for ${dep.name}`);
                    log.error(e);
                })
                .finally(() => {
                    depsWithInfo++;
                    log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`)
                    depProgressBar.increment();
                })
        );
        await Promise.all(promises);
    }
    console.timeEnd('Execution Time');

    depProgressBar.stop()

    const projectInfo = extractProjectStats(project)

    log.info('Project data saving in mongo db...')

    //todo save project info separate, stats + dependencies
   try {
        await cacheProjects.load()
        await cacheProjects.set?.(`${project.name}@${project.version}`, {
            name: project.name ?? project.path,
            projectPath: project.path,
            manifestFile: project.manifestFile,
            lockFile: project.lockFile,
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
   } catch (e: any) {
        log.error(`Error saving ${project.name}@${project.version} stats`, e)
   }

    //todo change dates
    const outOfSupportDate = moment().subtract(outOfSupportThreshold, 'months').format(dateFormat)
    const outdatedDate = moment().subtract(outdatedThreshold, 'months').format(dateFormat)

    try {
        await cacheProjects.set?.(`${project.name}@${project.version}`, {
            dependencies: Object.values(project.dependencies).map(dep => {
                const libraryInfo = dep.libraryInfo?.versions.find(version => dep.version === version.version)

                return {
                    _id: `${plugin.name}:${dep.name}`,
                    name: dep.name,
                    version: dep.version,
                    type: dep.type,
                    directDep: !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${project.name}@${project.version}`)),
                    requestedBy: dep.requestedBy.filter((value, index, array) => array.indexOf(value) === index),
                    vulnerabilities: (dep.libraryInfo?.vulnerabilities ?? []).length > 0,
                    outOfSupport: libraryInfo !== undefined ? new Date(libraryInfo.timestamp) < new Date(outOfSupportDate) : undefined,
                    outdated: libraryInfo !== undefined ? new Date(libraryInfo.timestamp) < new Date(outdatedDate) : undefined,
                    timestamp: libraryInfo?.timestamp,
                }
            }),
        })
    } catch (e: any) {
        log.error(`Error saving ${project.name}@${project.version} stats`, e)
    }

    log.info('Project data saving in mongo db done!')

    return `${project.name}@${project.version}`
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

export async function analyseFilesToCache(folders: string[], options: AnalyseOptions, useCache = true): Promise<string[]> {
    const projectIds: string[] = []
    const allFiles = folders.flatMap(walkDir)
    const selectedPlugins = getPluginsFromNames(options.plugins)

    log.info('Analyse options' + options)

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

        projectIds.push(...await processProjects(projects, plugin, cache, refreshedLibs, options, cacheProjects))
    }

    console.log('Projects in the system:', allProjects.length)

    log.info('Done')

    return projectIds
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
            if (!license)
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
