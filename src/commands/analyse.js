"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveToCsv = exports.analyseFilesToCache = exports.analyseCommand = void 0;
const commander_1 = require("commander");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const plugins_1 = require("../plugins");
const cli_common_1 = require("@dxworks/cli-common");
const vulnerabilities_1 = require("../utils/vulnerabilities");
const semver_1 = require("semver");
const lodash_1 = __importDefault(require("lodash"));
const spdx_correct_1 = __importDefault(require("spdx-correct"));
const moment_1 = __importDefault(require("moment"));
const cache_1 = require("../cache/cache");
const cache_2 = require("./cache");
const json_cache_1 = require("../cache/json-cache");
const cli_progress_1 = require("cli-progress");
const utils_1 = require("../utils/utils");
const blacklist_1 = require("../utils/blacklist");
const minimatch_1 = __importDefault(require("minimatch"));
const mongo_cache_1 = require("../cache/mongo-cache");
// import {defaultPlugins} from '../extension-points/plugin-loader'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const licenseIds = require('spdx-license-ids/');
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100;
exports.analyseCommand = new commander_1.Command()
    .name('analyse')
    .argument('[folders...]', 'A list of folders to walk for files')
    // .argument('[depext-files...]', 'A list of files to parse for dependency information')
    .option('--results, -r', 'The results folder', 'results')
    .option('--refresh', 'Refresh the cache', false)
    .option('--plugins, -p [plugins...]', 'A list of plugins')
    .action(analyseFilesToCache)
    .action(saveToCsv);
const outOfSupportThreshold = 24;
const outdatedThreshold = 15;
const dateFormat = 'MMM YYYY';
function chooseLibsCacheOption() {
    if ((0, cache_2.getMongoDockerContainerStatus)() != 'running') {
        cli_common_1.log.warn('Mongo cache is not running, using in-memory cache');
        return json_cache_1.jsonCacheLibrary;
    }
    cli_common_1.log.info('Mongo cache is up and running, using Mongo cache');
    return mongo_cache_1.mongoCacheLibrary;
}
function chooseProjectsCacheOption() {
    if ((0, cache_2.getMongoDockerContainerStatus)() != 'running') {
        cli_common_1.log.warn('Mongo cache is not running, using in-memory cache');
        return json_cache_1.jsonCacheProject;
    }
    cli_common_1.log.info('Mongo cache is up and running, using Mongo cache');
    return mongo_cache_1.mongoCacheProject;
}
function chooseSystemsCacheOption() {
    if ((0, cache_2.getMongoDockerContainerStatus)() != 'running') {
        cli_common_1.log.warn('Mongo cache is not running, using in-memory cache');
        return json_cache_1.jsonCacheSystem;
    }
    cli_common_1.log.info('Mongo cache is up and running, using Mongo cache');
    return mongo_cache_1.mongoCacheSystem;
}
function extractLicenses(dep) {
    return dep.libraryInfo?.licenses?.map(it => {
        if (typeof it === 'string')
            return it.substring(0, 100);
        else
            return JSON.stringify(it);
    });
}
async function extractProjects(plugin, files) {
    const projects = [];
    for (const context of plugin.extractor.createContexts(files)) {
        cli_common_1.log.info(`Parsing dependency tree information for ${JSON.stringify(context)}`);
        try {
            if (!plugin.parser) {
                cli_common_1.log.info(`Plugin ${plugin.name} does not have a parser!`);
                continue;
            }
            const proj = await plugin.parser.parseDependencyTree(context);
            cli_common_1.log.info(`Done parsing dependency tree information for ${JSON.stringify(context)}`);
            projects.push(proj);
        }
        catch (e) {
            cli_common_1.log.warn(`Exception parsing dependency tree information for ${JSON.stringify(context)}`);
            cli_common_1.log.error(e);
        }
    }
    return projects;
}
function extractProjectStats(proj) {
    const enhancedDeps = Object.values(proj.dependencies).map(dep => {
        const latestVersion = dep.libraryInfo?.versions.find(it => it.latest);
        const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim());
        const latestVersionMoment = (0, moment_1.default)(latestVersion?.timestamp);
        const currentVersionMoment = (0, moment_1.default)(currentVersion?.timestamp);
        const now = (0, moment_1.default)();
        const directDep = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`));
        return {
            ...dep,
            direct: directDep,
            latest_used: latestVersionMoment.diff(currentVersionMoment, 'months'),
            now_used: now.diff(currentVersionMoment, 'months'),
            now_latest: now.diff(latestVersionMoment, 'months'),
        };
    });
    const directDeps = enhancedDeps.filter(dep => dep.direct);
    const indirectDeps = enhancedDeps.filter(dep => !dep.direct);
    const directOutdated = directDeps.filter(dep => dep.latest_used > outdatedThreshold);
    const directOutDatedPercent = directDeps.length == 0 ? 0 : directOutdated.length / directDeps.length * 100;
    const indirectOutdated = indirectDeps.filter(dep => dep.latest_used > outdatedThreshold);
    const indirectOutDatedPercent = indirectDeps.length == 0 ? 0 : indirectOutdated.length / indirectDeps.length * 100;
    const directVulnerable = directDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0);
    const indirectVulnerable = indirectDeps.filter(dep => dep.vulnerabilities && dep.vulnerabilities.length > 0);
    const directOutOfSupport = directDeps.filter(dep => dep.now_latest > outOfSupportThreshold);
    const indirectOutOfSupport = indirectDeps.filter(dep => dep.now_latest > outOfSupportThreshold);
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
    };
}
function extractProjectLibs(proj, dep) {
    const latestVersion = dep.libraryInfo?.versions.find(it => it.latest);
    const currentVersion = dep.libraryInfo?.versions.find(it => it.version == dep.version.trim());
    const latestVersionMoment = (0, moment_1.default)(latestVersion?.timestamp);
    const currentVersionMoment = (0, moment_1.default)(currentVersion?.timestamp);
    const now = (0, moment_1.default)();
    const vulnerabilities = dep.vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n');
    const directDep = !dep.requestedBy || dep.requestedBy.some(it => it.startsWith(`${proj.name}@${proj.version}`));
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
    };
}
async function getLib(cache, plugin, dep, options, refreshedLibs) {
    let lib;
    if (await cacheHit(cache, plugin, dep, options.refresh, refreshedLibs)) {
        lib = await cache.get(`${plugin.name}:${dep.name}`);
    }
    else {
        // log.info(`Getting remote information on ${dep.name}`)
        lib = await plugin.registrar.retrieve(dep.name);
        if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
            // log.info(`Getting vulnerabilities for ${lib.name}`)
            lib.vulnerabilities = await (0, vulnerabilities_1.getVulnerabilitiesFromGithub)(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name);
        }
        await cache.set(`${plugin.name}:${dep.name}`, lib);
        if (options.refresh)
            refreshedLibs.push(dep.name);
    }
    return lib;
}
async function cacheHit(cache, plugin, dep, refresh, refreshedLibs) {
    if (refresh && !refreshedLibs.includes(dep.name)) {
        return false;
    }
    return cache.has(`${plugin.name}:${dep.name}`);
}
async function processProjects(projects, plugin, cache, refreshedLibs, options, cacheProjects) {
    const multiProgressBar = new cli_progress_1.MultiBar({}, cli_progress_1.Presets.shades_grey);
    const projectsBar = multiProgressBar.create(projects.length, 0, { name: 'Projects', state: 'Analysing' });
    for (const project of projects) {
        await processSingleProject(project, plugin, cache, refreshedLibs, options, cacheProjects);
        projectsBar.increment();
    }
    projectsBar.stop();
    await cacheProjects.write();
    await cache.write();
}
async function processSingleProject(project, plugin, cache, refreshedLibs, options, cacheProjects) {
    cli_common_1.log.info(`Plugin ${plugin.name} analyzing project ${project.name}@${project.version}`);
    const dependencies = Object.values(project.dependencies);
    const filteredDependencies = dependencies.filter(it => !blacklist_1.blacklistedGlobs.some(glob => (0, minimatch_1.default)(it.name, glob)));
    const multiProgressBar = new cli_progress_1.MultiBar({}, cli_progress_1.Presets.shades_grey);
    const depProgressBar = multiProgressBar.create(filteredDependencies.length, 0, {
        name: 'Deps',
        state: 'Analysing deps',
    });
    let depsWithInfo = 0;
    for (const dep of filteredDependencies) {
        try {
            dep.libraryInfo = await getLib(cache, plugin, dep, options, refreshedLibs);
        }
        catch (e) {
            cli_common_1.log.warn(`Exception getting remote info for ${dep.name}`);
            cli_common_1.log.error(e);
        }
        depProgressBar.increment();
        depsWithInfo++;
        cli_common_1.log.info(`Got remote information on ${dep.name} (${depsWithInfo}/${filteredDependencies.length})`);
    }
    depProgressBar.stop();
    const projectInfo = extractProjectStats(project);
    cli_common_1.log.info('Project data saving in mongo db...');
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
    });
    const outOfSupportDate = (0, moment_1.default)().subtract(outOfSupportThreshold, 'months').format(dateFormat);
    const outdatedDate = (0, moment_1.default)().subtract(outdatedThreshold, 'months').format(dateFormat);
    await cacheProjects.set(`${project.name}@${project.version}`, {
        dependencies: Object.values(project.dependencies).map(dep => {
            const libraryInfo = dep.libraryInfo?.versions.find(version => dep.version === version.version);
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
            };
        }),
    });
    cli_common_1.log.info('Project data saving in mongo db done!');
}
async function processSystem(projects, useCache) {
    const cache = useCache ? chooseSystemsCacheOption() : cache_1.noCache;
    await cache.load();
    const strings = [];
    for (const project of projects) {
        strings.push(project.path);
    }
    let systemName = strings[0];
    for (let i = 1; i < strings.length; i++) {
        while (strings[i].indexOf(systemName) !== 0) {
            systemName = systemName.substring(0, systemName.length - 1);
            if (systemName === '')
                return '';
        }
    }
    console.log('system name' + systemName);
    await cache.set(systemName, {
        name: systemName,
        projectPath: systemName,
        projects: projects.map(it => `${it.name}@${it.version}`),
    });
}
function filterFilesForPlugin(allFiles, plugin) {
    return allFiles.filter(file => {
        if (plugin.extractor.filter && !plugin.extractor.filter(file)) {
            return false;
        }
        return plugin.extractor.files.some((pattern) => (0, minimatch_1.default)(file, pattern, { matchBase: true }));
    });
}
async function analyseFilesToCache(folders, options, useCache = true) {
    const allFiles = folders.flatMap(utils_1.walkDir);
    const selectedPlugins = (0, plugins_1.getPluginsFromNames)(options.plugins);
    const cache = useCache ? chooseLibsCacheOption() : cache_1.noCache;
    const cacheProjects = useCache ? chooseProjectsCacheOption() : cache_1.noCache;
    await cache.load();
    const allProjects = [];
    for (const plugin of selectedPlugins) {
        cli_common_1.log.info(`Plugin ${plugin.name} starting`);
        const refreshedLibs = [];
        const files = filterFilesForPlugin(allFiles, plugin);
        const projects = await extractProjects(plugin, files);
        allProjects.push(...projects);
        await processProjects(projects, plugin, cache, refreshedLibs, options, cacheProjects);
    }
    console.log('Projects in the system:', allProjects.length);
    await processSystem(allProjects, useCache);
    cli_common_1.log.info('Done');
}
exports.analyseFilesToCache = analyseFilesToCache;
async function saveToCsv(folders, options, useCache = true) {
    const resultFolder = options.results || 'results';
    if (!fs_1.default.existsSync(path_1.default.resolve(process.cwd(), resultFolder))) {
        fs_1.default.mkdirSync(path_1.default.resolve(process.cwd(), resultFolder), { recursive: true });
        cli_common_1.log.info('Creating results dir');
    }
    const refreshedLibs = [];
    const selectedPlugins = (0, plugins_1.getPluginsFromNames)(options.plugins);
    const allFiles = folders.flatMap(it => (0, utils_1.walkDir)(it));
    const cache = useCache ? chooseLibsCacheOption() : cache_1.noCache;
    await cache.load();
    for (const plugin of selectedPlugins) {
        const files = allFiles
            .filter(it => plugin.extractor.filter ? plugin.extractor.filter(it) : true)
            .filter(it => plugin.extractor.files
            .some(pattern => (0, minimatch_1.default)(it, pattern, { matchBase: true })));
        const projects = await extractProjects(plugin, files);
        for (const project of projects) {
            const dependencies = Object.values(project.dependencies);
            const filteredDependencies = dependencies.filter(it => !blacklist_1.blacklistedGlobs.some(glob => (0, minimatch_1.default)(it.name, glob)));
            await extractProjects(plugin, files);
            for (const dep of filteredDependencies) {
                try {
                    const lib = await getLib(cache, plugin, dep, options, refreshedLibs);
                    dep.libraryInfo = lib;
                    const thisVersionVulnerabilities = lib.vulnerabilities?.filter((it) => {
                        try {
                            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                            const range = new semver_1.Range(it.vulnerableRange?.replaceAll(',', ' ') ?? '');
                            return range.test(dep.version);
                        }
                        catch (e) {
                            // log.warn(`Vulnerable range unknown: ${it.vulnerableRange}`)
                            return false;
                        }
                    });
                    dep.vulnerabilities = thisVersionVulnerabilities || [];
                }
                catch (e) {
                    cli_common_1.log.warn(`Exception getting remote info for ${dep.name}`);
                    cli_common_1.log.error(e);
                }
            }
        }
        const allLibsInfo = projects.flatMap(proj => Object.values(proj.dependencies).map(dep => dep.libraryInfo))
            .filter(it => it !== undefined && it != null).map(it => it);
        const allLicenses = lodash_1.default.groupBy(allLibsInfo, (lib) => {
            const license = lib.versions.flatMap(it => it.licenses).find(() => true);
            if (!license || typeof license !== 'string')
                return 'unknown';
            if (!licenseIds.includes(license))
                return (0, spdx_correct_1.default)(license || 'unknown') || 'unknown';
            return license;
        });
        fs_1.default.writeFileSync(path_1.default.resolve(process.cwd(), resultFolder, `${plugin.name}-licenses.csv`), Object.keys(allLicenses).map(l => {
            return `${l},${allLicenses[l].length},${allLicenses[l].map((it) => it.name)}`;
        }).join('\n'));
        const header = 'Project Path,Project,Library,Used Version,Latest Version,Used Version Release Date,Latest Version Release Date,Latest-Used,Now-Used,Now-latest,Vulnerabilities,Vulnerability Details,DirectDependency,Type,Licenses\n';
        fs_1.default.writeFileSync(path_1.default.resolve(process.cwd(), resultFolder, `${plugin.name}-libs.csv`), header + projects.flatMap(proj => Object.values(proj.dependencies).map(dep => {
            const data = extractProjectLibs(proj, dep);
            return `${data.path},${data.name},${data.name},${data.version},${data.latestVersion},${data.usedVersionReleaseDate},${data.latestVersionReleaseDate},${data.latestUsed},${data.nowUsed},${data.nowLatest},"${data.vulnerabilities}",${data.vulnerabilityDetails},${data.directDependency},"${data.type}","${data.licenses}"`;
        })).join('\n'));
        const cacheProjects = useCache ? chooseProjectsCacheOption() : cache_1.noCache;
        await cacheProjects.load();
        const projectStatsHeader = 'Project Path,Project,Direct Deps,Indirect Deps,Direct Outdated Deps, Direct Outdated %,Indirect Outdated Deps, Indirect Outdated %, Direct Vulnerable Deps, Indirect Vulnerable Deps, Direct Out of Support, Indirect Out of Support\n';
        fs_1.default.writeFileSync(path_1.default.resolve(process.cwd(), resultFolder, `${plugin.name}-project-stats.csv`), projectStatsHeader + projects.map(proj => {
            const projectInfo = extractProjectStats(proj);
            return `${projectInfo.projectPath},${projectInfo.name},${projectInfo.directDeps},${projectInfo.indirectDeps},${projectInfo.directOutdatedDeps},${projectInfo.directOutdatedDepsPercentage},${projectInfo.indirectOutdatedDeps},${projectInfo.indirectOutdatedDepsPercentage},${projectInfo.directVulnerableDeps},${projectInfo.indirectVulnerableDeps},${projectInfo.directOutOfSupport},${projectInfo.indirectOutOfSupport}`;
        }).join('\n'));
    }
    cli_common_1.log.info(`Results are written to ${path_1.default.resolve(process.cwd(), resultFolder)}`);
    cli_common_1.log.info('Done');
}
exports.saveToCsv = saveToCsv;
