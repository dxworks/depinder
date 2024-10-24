import {Command} from 'commander'
import git from 'isomorphic-git'
import {AnalyseOptions} from '../analyse'
import {getPluginsFromNames} from '../../plugins'
import {DepinderProject} from "../../extension-points/extract"
import {Plugin} from "../../extension-points/plugin"
import minimatch from "minimatch";
import {log} from "../../utils/logging"
import path from "path"
import {depinderTempFolder} from "../../utils/utils"
import {promises as fs} from 'fs'

export const historyCommand = new Command()
    .name('history')
    .argument('[folders...]', 'A list of git repositories to analyse')
    .option('--results, -r', 'The results folder', 'results')
    .option('--refresh', 'Refresh the cache', false)
    .option('--plugins, -p [plugins...]', 'A list of plugins')
    .action(analyseHistory);

export async function analyseHistory(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    const selectedPlugins = getPluginsFromNames(options.plugins);
    if (folders.length === 0) {
        console.log('No folders provided to analyze.');
        return;
    }

    const commitProjectsMap: Map<string, { commit: any, projects: DepinderProject[] }[]> = new Map();

    for (const folder of folders) {
        const commits = await getCommits(folder);
        if (commits.length === 0) {
            console.log(`No commits found for ${folder}`);
            continue;
        }
        for (const commit of commits) {
            await processCommitForPlugins(commit, folder, selectedPlugins, commitProjectsMap);
        }
    }

    console.log(commitProjectsMap);
}

// Function to fetch commits from a Git repository
async function getCommits(folder: string): Promise<any[]> {
    try {
        return await git.log({
            fs,
            dir: folder,
        });
    } catch (error) {
        console.error(`Failed to get commits for ${folder}:`, error);
        return [];
    }
}

// Function to process each commit and update the map by plugin
async function processCommitForPlugins(
    commit: any,
    folder: string,
    selectedPlugins: Plugin[],
    commitProjectsMap: Map<string, { commit: any, projects: DepinderProject[] }[]>
) {
    const changes = await getChangedFiles(commit, folder);
    await ensureDirectoryExists(depinderTempFolder);

    for (const plugin of selectedPlugins) {
        let filteredFiles = changes
            .filter((file) => (plugin.extractor.filter ? plugin.extractor.filter(file) : true))
            .filter((file) => plugin.extractor.files.some((pattern) => minimatch(file, pattern, { matchBase: true })));

        if (filteredFiles.includes('package.json') || filteredFiles.includes('package-lock.json')) {
            if (!filteredFiles.includes('package.json')) {
                filteredFiles.push('package.json');
            }
            if (!filteredFiles.includes('package-lock.json')) {
                filteredFiles.push('package-lock.json');
            }
        }

        if (filteredFiles.length > 0) {
            console.log('Filtered Files: ' + filteredFiles);
            const tempFilePaths: string[] = [];
            for (const file of filteredFiles) {
                const tempFilePath = path.join(depinderTempFolder, `${commit.oid}-${path.basename(file)}`);
                try {
                    const fileContent = await git.readBlob({
                        fs,
                        dir: folder,
                        oid: commit.oid,
                        filepath: file,
                    });

                    await fs.writeFile(tempFilePath, fileContent.blob);
                    tempFilePaths.push(tempFilePath);
                } catch (error) {
                    console.error(`Failed to create temp file for ${file} at commit ${commit.oid}:`, error);
                }
            }

            const projects: DepinderProject[] = await extractProjects(plugin, tempFilePaths);

            projects.forEach(project => {
                const dependencyIds = Object.keys(project.dependencies);
                console.log(`Project: ${project.name}, Dependencies: ${dependencyIds}`);
            });

            await cleanupTempFiles(tempFilePaths);

            if (!commitProjectsMap.has(plugin.name)) {
                commitProjectsMap.set(plugin.name, []);
            }
            commitProjectsMap.get(plugin.name)!.push({ commit, projects });
        }
    }
}

async function getChangedFiles(commit: any, folder: string): Promise<string[]> {
    const changedFiles: string[] = [];

    const currentCommitOid = commit.oid;
    const parentCommitOid = commit.commit.parent[0];

    try {
        const diff = await git.walk({
            fs,
            dir: folder,
            trees: [git.TREE({ ref: currentCommitOid }), git.TREE({ ref: parentCommitOid })],
            map: async function (filepath, [head, base]) {
                if (!head && base) {
                    // File was deleted
                    changedFiles.push(filepath);
                } else if (head && !base) {
                    // File was added
                    changedFiles.push(filepath);
                } else if (head && base) {
                    // File was modified
                    const headOid = await head.oid();
                    const baseOid = await base.oid();
                    if (headOid !== baseOid) {
                        changedFiles.push(filepath);
                    }
                }
            }
        });

    } catch (error) {
        console.error(`Error getting changed files for commit ${currentCommitOid}:`, error);
    }

    return changedFiles;
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


// Function to ensure the directory exists
async function ensureDirectoryExists(directoryPath: string) {
    try {
        await fs.mkdir(directoryPath, { recursive: true });
    } catch (error) {
        console.error(`Failed to create directory: ${directoryPath}`, error);
    }
}


// Function to clean up temp files after processing
async function cleanupTempFiles(tempFilePaths: string[]) {
    for (const filePath of tempFilePaths) {
        try {
            await fs.unlink(filePath);
        } catch (error) {
        }
    }
}