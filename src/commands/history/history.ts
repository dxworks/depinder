import { Command } from 'commander'
import git from 'isomorphic-git'
import fs from 'fs'
import { AnalyseOptions } from '../analyse'
import { getPluginsFromNames } from '../../plugins'
import { DepinderProject } from "../../extension-points/extract";
import { Plugin } from "../../extension-points/plugin";

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
}

// Function to fetch commits from a Git repository
async function getCommits(folder: string): Promise<any[]> {
    console.log("folder: " + folder);
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
