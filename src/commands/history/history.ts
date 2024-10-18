import {Command} from 'commander'
import git from 'isomorphic-git'
import fs from 'fs'
import {AnalyseOptions} from '../analyse'
import {getPluginsFromNames} from '../../plugins'
import {DepinderProject} from "../../extension-points/extract"
import {Plugin} from "../../extension-points/plugin"
import minimatch from "minimatch";
import {log} from "../../utils/logging"

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
    const projectMap: Map<string, { commit: string, projects: DepinderProject[] }[]> = new Map();

    for (const folder of folders) {
        const commits = await getCommits(folder);
        if (commits.length === 0) {
            console.log(`No commits found for ${folder}`);
            continue;
        }
        for (const commit of commits) {
            await processCommitForPlugins(commit, folder, selectedPlugins, projectMap);
        }
    }
}

// Function to process each commit and update the map by plugin
async function processCommitForPlugins(commit: any, folder: string, selectedPlugins: Plugin[], projectMap: Map<string, { commit: string, projects: DepinderProject[] }[]>) {
    console.log('Commit:', JSON.stringify(commit, null, 2));
    const changes = await getChangedFiles(commit, folder);
    console.log("Changes: ", changes);

    for (const plugin of selectedPlugins) {
        const filteredFiles = changes
            .filter(file => plugin.extractor.filter ? plugin.extractor.filter(file) : true)
            .filter(file => plugin.extractor.files.some(pattern => minimatch(file, pattern, {matchBase: true})));
        console.log("Filtered Files: " + filteredFiles);

        if (filteredFiles.length > 0) {
            // Create DepinderProjects
            const projects: DepinderProject[] = await extractProjects(plugin, filteredFiles, commit, folder);

            for (const project of projects) {
              console.log("projects: " + projects.length)
              console.log(`Plugin ${plugin.name} analyzing project ${project.name}@${project.version}`)
                if (project.dependencies) {
                    console.log(`Dependencies for project in commit ${commit.oid}:`, project.dependencies);
                } else {
                    console.log(`No dependencies found for project in commit ${commit.oid}`);
                }
            }
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

async function extractProjects(plugin: Plugin, files: string[], commit: any, folder: string): Promise<DepinderProject[]> {
    const projects: DepinderProject[] = [];

    for (const context of plugin.extractor.createContexts(files)) {
        log.info(`Parsing dependency tree information for context: ${JSON.stringify(context)}`);

        const manifestFile = context.manifestFile || '';
        let manifestContent: any;
        log.info(manifestFile);

        if (manifestFile) {
            try {
                // Read the manifest file from the specific commit
                const manifestBuffer = await git.readBlob({
                    fs,
                    dir: folder,
                    oid: commit.oid,
                    filepath: manifestFile
                });

                // Convert the Uint8Array buffer to a UTF-8 string
                const rawContent = new TextDecoder("utf-8").decode(manifestBuffer.blob);

                // Log the raw content for debugging purposes
                log.info(`Raw content of ${manifestFile} from commit ${commit.oid}:\n${rawContent}`);

                // Try to parse the content as JSON directly
                manifestContent = JSON.parse(rawContent);
            } catch (error) {
                // If JSON parsing fails or if the file cannot be read, log the error
                if (error instanceof SyntaxError) {
                    log.error(`Manifest file ${manifestFile} in commit ${commit.oid} is not valid JSON: ${error.message}`);
                } else {
                    log.error(`Failed to read or parse ${manifestFile} from commit ${commit.oid}:`, error);
                }
                continue; // Skip this context if we can't read or parse the manifest file
            }
        } else {
            log.warn(`No manifest file defined in context for plugin ${plugin.name}`);
            continue;
        }

        // Now that we have the manifest content, extract the project name and version
        const projectName = manifestContent.name || `Unnamed Project (commit: ${commit.oid})`;
        const projectVersion = manifestContent.version || '0.0.0';

        try {
            if (!plugin.parser) {
                log.warn(`Plugin ${plugin.name} does not have a parser, skipping...`);
                continue;
            }

            // Parse dependencies from the context
            const proj: DepinderProject = await plugin.parser.parseDependencyTree(context);
            proj.name = projectName;
            proj.version = projectVersion;

            log.info(`Successfully parsed dependency tree for ${projectName}@${projectVersion}`);
            projects.push(proj);
        } catch (error: any) {
            log.error(`Error while parsing dependency tree for project in commit ${commit.oid}:`, error);
        }
    }

    return projects;
}
