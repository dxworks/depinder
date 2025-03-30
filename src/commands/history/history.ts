import {Command} from 'commander'
import {AnalyseOptions} from '../analyse'
import {getPluginsFromNames} from '../../plugins'
import {DepinderProject} from "../../extension-points/extract"
import {log} from '../../utils/logging'
import {getCommits, processCommitForPlugins} from './history-git-commit'
import {promises as fs} from 'fs'
import path from 'path'
import * as os from "os"

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

  const commitProjectsMap: Map<string, { commit: any; projects: DepinderProject[] | "error" }[]> = new Map();

  for (const folder of folders) {
    const commits = await getCommits(folder);
    if (commits.length === 0) {
      log.info(`No commits found for ${folder}`);
      continue;
    }
    const sortedCommits = sortCommitsInOrder(commits);
    const testCommits = sortedCommits.slice(0, 20); // take only the first 20 commits for testing
    for (const commit of testCommits) {
      await processCommitForPlugins(commit, folder, selectedPlugins, commitProjectsMap);
    }
  }

  const pluginDependencyHistory = await compareDependenciesBetweenCommits(commitProjectsMap);

  for (const [pluginName, dependencyHistory] of pluginDependencyHistory.entries()) {
    await processDependencyHistory(pluginName, dependencyHistory);
    await processCommitDependencyHistory(pluginName, dependencyHistory);
  }
}

async function processDependencyHistory(pluginName: string, dependencyHistory: DependencyHistory): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const homeDir = os.homedir();
  const outputPath = path.join(homeDir, 'OutputReportsOfHistory');
  await fs.mkdir(outputPath, { recursive: true });
  const depHistoryFile = path.join(outputPath, `dependency-history-${pluginName}-${timestamp}.json`);
  await fs.writeFile(depHistoryFile, JSON.stringify(dependencyHistory, null, 2), 'utf8');
}

async function processCommitDependencyHistory(pluginName: string, dependencyHistory: DependencyHistory): Promise<void> {
  const commitDepHistory: CommitDependencyHistory = createCommitDependencyHistory(dependencyHistory);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const homeDir = os.homedir();
  const outputPath = path.join(homeDir, 'OutputReportsOfHistory');
  await fs.mkdir(outputPath, { recursive: true });
  const commitDepHistoryFile = path.join(outputPath, `commit-dependency-history-${pluginName}-${timestamp}.json`);
  await fs.writeFile(commitDepHistoryFile, JSON.stringify(commitDepHistory, null, 2), 'utf8');
}

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
  return sortedCommits;
}

async function compareDependenciesBetweenCommits(
  commitProjectsMap: Map<string, { commit: any; projects: DepinderProject[] | "error" }[]>
): Promise<Map<string, DependencyHistory>> {
  const pluginDependencyHistory = new Map<string, DependencyHistory>();
  for (const [pluginName, entries] of commitProjectsMap.entries()) {
    const pluginHistory: DependencyHistory = {};
    const lastValidProjects: Map<string, DepinderProject> = new Map();

    for (const entry of entries) {
      if (entry.projects === 'error') continue;
      const commitDate = new Date(entry.commit.commit.committer.timestamp * 1000).toISOString();

      for (const project of entry.projects) {
        const projectKey = project.name;
        const currentDeps = getDependencyMap(project);
        const previousProject = lastValidProjects.get(projectKey);

        if (!previousProject) {
          for (const [depName, version] of Object.entries(currentDeps)) {
            if (!pluginHistory[depName]) pluginHistory[depName] = { history: [] };
            pluginHistory[depName].history.push({
              commitOid: entry.commit.oid,
              date: commitDate,
              action: 'ADDED',
              version,
              project: projectKey
            });
          }
        } else {
          const previousDeps = getDependencyMap(previousProject);
          const changes = identifyDependencyChanges(previousDeps, currentDeps);
          await processDependencyChanges(pluginHistory, changes, entry.commit.oid, commitDate, projectKey);
        }

        lastValidProjects.set(projectKey, project);
      }
    }
    pluginDependencyHistory.set(pluginName, pluginHistory);
  }
  return pluginDependencyHistory;
}

async function processDependencyChanges(
  dependencyHistory: DependencyHistory,
  changes: { added: string[]; removed: string[]; modified: { dependency: string; from: string; to: string }[] },
  commitOid: string,
  commitDate: string,
  project: string
) {
  for (const added of changes.added) {
    const [depName, version] = added.split('@');
    if (!dependencyHistory[depName]) dependencyHistory[depName] = { history: [] };
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: 'ADDED',
      version,
      project
    });
  }

  for (const removed of changes.removed) {
    const [depName, version] = removed.split('@');
    if (!dependencyHistory[depName]) dependencyHistory[depName] = { history: [] };
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: 'DELETED',
      version,
      project
    });
  }

  for (const { dependency, from, to } of changes.modified) {
    if (!dependencyHistory[dependency]) dependencyHistory[dependency] = { history: [] };
    dependencyHistory[dependency].history.push({
      commitOid,
      date: commitDate,
      action: 'MODIFIED',
      fromVersion: from,
      toVersion: to,
      project
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

function identifyDependencyChanges(
  currentDeps: Record<string, string>,
  nextDeps: Record<string, string>
) {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: { dependency: string; from: string; to: string }[] = [];

  for (const dep in currentDeps) {
    if (!nextDeps[dep]) {
      removed.push(`${dep}@${currentDeps[dep]}`);
    } else if (currentDeps[dep] !== nextDeps[dep]) {
      modified.push({ dependency: dep, from: currentDeps[dep], to: nextDeps[dep] });
    }
  }

  for (const dep in nextDeps) {
    if (!currentDeps[dep]) {
      added.push(`${dep}@${nextDeps[dep]}`);
    }
  }

  return { added, removed, modified };
}

function createCommitDependencyHistory(dependencyHistory: DependencyHistory): CommitDependencyHistory {
  const commitDependencyHistory: CommitDependencyHistory = {};
  for (const [depName, depData] of Object.entries(dependencyHistory)) {
    for (const statusEntry of depData.history) {
      const { commitOid, project } = statusEntry;
      if (!commitDependencyHistory[commitOid!]) {
        commitDependencyHistory[commitOid!] = { history: [] };
      }
      commitDependencyHistory[commitOid!].history.push({
        ...statusEntry,
        commitOid: undefined,
        depinderDependencyName: depName,
        project
      });
    }
  }
  return commitDependencyHistory;
}
