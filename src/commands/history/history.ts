import {Command} from 'commander'
import {AnalyseOptions} from '../analyse'
import {getPluginsFromNames} from '../../plugins'
import {DepinderProject} from "../../extension-points/extract"
import {log} from '../../utils/logging'
import {getCommits, processCommitForPlugins} from './history-git-commit'

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
    const sortedCommits = sortCommitsInOrder(commits);
    const testCommits = sortedCommits.slice(0, 20); // take only the first 20 commits for testing
    for (const commit of testCommits) {
      console.log("Commit: " + commit.oid + " Parent: " + commit.commit.parent);
      await processCommitForPlugins(commit, folder, selectedPlugins, commitProjectsMap);
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

// sort git commits => based on Kahn's Algorithm for Topological Sorting
function sortCommitsInOrder(commits: any[]): any[] {
  const commitMap = new Map<string, any>();
  const indegreeMap = new Map<string, number>();
  const childrenMap = new Map<string, any[]>();
  commits.forEach(commit => {
    commitMap.set(commit.oid, commit);
    if (!indegreeMap.has(commit.oid)) {
      indegreeMap.set(commit.oid, 0);
    }
    commit.commit.parent.forEach((parentOid: string) => {
      if (!childrenMap.has(parentOid)) {
        childrenMap.set(parentOid, []);
      }
      childrenMap.get(parentOid)!.push(commit);
      indegreeMap.set(commit.oid, (indegreeMap.get(commit.oid) || 0) + 1);
    });
  });
  const rootCommits = commits.filter(commit => commit.commit.parent.length === 0);
  const sortedCommits: any[] = [];
  const queue: any[] = [...rootCommits];

  while (queue.length > 0) {
    const currentCommit = queue.shift();
    sortedCommits.push(currentCommit);
    if (childrenMap.has(currentCommit.oid)) {
      for (const child of childrenMap.get(currentCommit.oid)!) {
        const childIndegree = (indegreeMap.get(child.oid) || 0) - 1;
        indegreeMap.set(child.oid, childIndegree);
        if (childIndegree === 0) {
          queue.push(child);
        }
      }
    }
  }
  const remainingCommits = commits.filter(commit => indegreeMap.get(commit.oid) !== 0);
  if (remainingCommits.length > 0) {
    console.warn('Detected a cycle in the commit graph, which cannot be fully sorted.');
  }
  return sortedCommits;
}

// Function to compare dependencies across commits
async function compareDependenciesBetweenCommits(
  commitProjectsMap: Map<string, { commit: any; projects: DepinderProject[] | "error" }[]>,
  dependencyHistory: DependencyHistory
) {
  for (const [pluginName, entries] of commitProjectsMap.entries()) {
    entries.forEach(entry => {
      console.log("Commit OID:", entry.commit.oid);
    });
    let lastValidEntry: { commit: any; projects: DepinderProject[] } | null = null;

    for (const entry of entries) {
      if (entry.projects === "error") {
        console.log(
          `Skipping entry for plugin ${pluginName} at commit ${entry.commit.oid} due to errors.`
        );
        continue;
      }

      if (lastValidEntry) {
        const currentDeps = getDependencyMap(lastValidEntry.projects[0]);
        const nextDeps = getDependencyMap(entry.projects[0]);
        const changes = identifyDependencyChanges(currentDeps, nextDeps);
        const commitDate = new Date(entry.commit.commit.committer.timestamp * 1000).toISOString();
        await processDependencyChanges(dependencyHistory, changes, entry.commit.oid, commitDate);
      }

      lastValidEntry = entry as { commit: any; projects: DepinderProject[] };
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
