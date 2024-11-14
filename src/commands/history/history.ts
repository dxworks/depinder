import {Command} from 'commander'
import {AnalyseOptions} from '../analyse'
import {getPluginsFromNames} from '../../plugins'
import {DepinderProject} from "../../extension-points/extract"
import {log} from "../../utils/logging"
import {getCommits, processCommitForPlugins} from "./history-git-commit"

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
    log.info('No folders provided to analyze.');
    return;
  }

  const commitProjectsMap: Map<string, { commit: any, projects: DepinderProject[] }[]> = new Map();

  for (const folder of folders) {
    const commits = await getCommits(folder);
    if (commits.length === 0) {
      log.info(`No commits found for ${folder}`);
      continue;
    }
    for (const commit of commits) {
      if (commit.commit.parent.length < 2) { // Skip merge commits
        await processCommitForPlugins(commit, folder, selectedPlugins, commitProjectsMap);
      }
    }
  }

  const dependencyHistory: DependencyHistory = {};
  await compareDependenciesBetweenCommits(commitProjectsMap, dependencyHistory);
  console.log('Dependency history:');
  for (const [depName, depHistory] of Object.entries(dependencyHistory)) {
    console.log(`Dependency: ${depName}`);
    console.log(JSON.stringify(depHistory.history, null, 2));
  }
}

// Function to compare dependencies across commits
async function compareDependenciesBetweenCommits(
  commitProjectsMap: Map<string, { commit: any, projects: DepinderProject[] }[]>,
  dependencyHistory: DependencyHistory
) {
  for (const [pluginName, entries] of commitProjectsMap.entries()) {
    const reversedEntries = [...entries].reverse();

    for (let i = 1; i < reversedEntries.length; i++) {
      const currentEntry = reversedEntries[i - 1];
      const nextEntry = reversedEntries[i];
      const currentDeps = getDependencyMap(currentEntry.projects[0]);
      const nextDeps = getDependencyMap(nextEntry.projects[0]);
      const changes = identifyDependencyChanges(currentDeps, nextDeps);
      const commitDate = new Date(nextEntry.commit.commit.committer.timestamp * 1000).toISOString();
      await processDependencyChanges(dependencyHistory, changes, nextEntry.commit.oid, commitDate);
    }
  }
}

async function processDependencyChanges(
  dependencyHistory: DependencyHistory,
  changes: { added: string[]; removed: string[]; modified: { dependency: string; from: string; to: string }[] },
  commitOid: string,
  commitDate: string,
) {
  // Process added dependencies
  for (const added of changes.added) {
    const [depName, version] = added.split('@');
    if (!dependencyHistory[depName]) {
      dependencyHistory[depName] = {
        history: []
      };
    }
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: "ADDED",
      version
    });
  }

  // Process removed dependencies
  for (const removed of changes.removed) {
    const [depName, version] = removed.split('@');
    if (!dependencyHistory[depName]) {
      dependencyHistory[depName] = {
        history: []
      };
    }
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: "DELETED",
      version
    });
  }

  // Process modified dependencies
  for (const modified of changes.modified) {
    const {dependency: depName, from, to} = modified;
    if (!dependencyHistory[depName]) {
      dependencyHistory[depName] = {
        history: []
      };
    }
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: "MODIFIED",
      fromVersion: from,
      toVersion: to
    });
  }
}

function getDependencyMap(project: DepinderProject | undefined): Record<string, string> {
  if (!project) return {};
  return Object.values(project.dependencies).reduce((map, dep) => {
    const [name, version] = dep.id.split('@');
    map[name] = version;
    return map;
  }, {} as Record<string, string>);
}

// Function to identify added, removed, and modified dependencies between two maps
function identifyDependencyChanges(
  currentDeps: Record<string, string>,
  nextDeps: Record<string, string>
) {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: { dependency: string, from: string, to: string }[] = [];

  for (const dep in currentDeps) {
    if (!nextDeps[dep]) {
      removed.push(`${dep}@${currentDeps[dep]}`);
    } else if (currentDeps[dep] !== nextDeps[dep]) {
      modified.push({dependency: dep, from: currentDeps[dep], to: nextDeps[dep]});
    }
  }

  for (const dep in nextDeps) {
    if (!currentDeps[dep]) {
      added.push(`${dep}@${nextDeps[dep]}`);
    }
  }

  return {added, removed, modified};
}
