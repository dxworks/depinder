import {Command} from 'commander'
import {getPluginsFromNames} from '../../plugins'
import { DepinderProject, Extractor, Parser } from "../../extension-points/extract"
import {log} from '../../utils/logging'
import {getCommits, processCommitForPlugins} from './history-git-commit'
import {promises as fs} from 'fs'
import path from 'path'
import * as os from "os"
import {LibraryInfo, Registrar} from "../../extension-points/registrar"
import {VulnerabilityChecker} from "../../extension-points/vulnerability-checker"
import {CodeFinder} from "../../extension-points/code-impact"
import {getVulnerabilitiesFromGithub} from "../../utils/vulnerabilities"
import pLimit from 'p-limit'

export interface HistoryOptions {
  plugins?: string[]
  results: string
}

export interface Plugin {
  name: string // the name of the technology (could be language name or package manager name)
  aliases?: string[] // potential aliases to use from CLI
  extractor: Extractor // defines which files to search for
  parser?: Parser // defines how to parse the files specified by the extractor and returns a tree with all dependencies
  registrar: Registrar // gets information about libraries from package manager apis
  checker?: VulnerabilityChecker // checks for vulnerabilities for the found dependencies

  codeFinder?: CodeFinder // finds the references in code for a all dependencies of a project
}

export const historyCommand = new Command()
  .name('history')
  .argument('[folders...]', 'A list of git repositories to analyse')
  .option('--results, -r', 'The results folder', 'results')
  .option('--plugins, -p [plugins...]', 'A list of plugins')
  .action(analyseHistory);

export async function analyseHistory(folders: string[], options: HistoryOptions, useCache = true): Promise<void> {
  const selectedPlugins: Plugin[] = getPluginsFromNames(options.plugins);
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
    for (const commit of sortedCommits) {
      await processCommitForPlugins(commit, folder, selectedPlugins, commitProjectsMap);
    }
  }

  const pluginDependencyHistory = await compareDependenciesBetweenCommits(commitProjectsMap);

  await saveCombinedDependencyHistory(pluginDependencyHistory, options.results);
  await saveLibrariesToJson(selectedPlugins, pluginDependencyHistory, options.results);

}

async function saveLibrariesToJson(
  selectedPlugins: Plugin[],
  pluginDependencyHistory: Map<string, DependencyHistory>,
  resultsFolder: string
) {
  const idsToUpdate = new Set<string>();
  for (const [pluginName, depHistory] of pluginDependencyHistory.entries()) {
    for (const depName of Object.keys(depHistory)) {
      idsToUpdate.add(`${pluginName}:${depName}`);
    }
  }
  const idsArray = Array.from(idsToUpdate);
  const libraryInfoMap: Record<string, { plugin: string; info: LibraryInfo }> = {};

  const limit = pLimit(10);

  const retrievalTasks = idsArray.map(id =>
    limit(async () => {
      const plugin = selectedPlugins.find(p => id.startsWith(`${p.name}:`));
      if (!plugin) return;

      const libraryName = id.substring(plugin.name.length + 1);
      try {
        const lib = await plugin.registrar.retrieve(libraryName);
        if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
          try {
            lib.vulnerabilities = await getVulnerabilitiesFromGithub(
              plugin.checker.githubSecurityAdvisoryEcosystem,
              lib.name
            );
          } catch {}
        }

        return {
          id,
          plugin: plugin.name,
          info: lib
        };
      } catch {
        return undefined;
      }
    })
  );
  const results = await Promise.all(retrievalTasks);
  for (const result of results) {
    if (result) {
      libraryInfoMap[result.id] = {
        plugin: result.plugin,
        info: result.info
      };
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const homeDir = os.homedir();
  const outputPath = path.join(homeDir, resultsFolder);
  await fs.mkdir(outputPath, { recursive: true });

  const filePath = path.join(outputPath, `library-info-${timestamp}.json`);
  await fs.writeFile(filePath, JSON.stringify(libraryInfoMap, null, 2), 'utf8');
}

async function saveCombinedDependencyHistory(
  pluginDependencyHistory: Map<string, DependencyHistory>,
  resultsFolder: string
) {
  const combinedDepHistory: DependencyHistory = {};
  const combinedCommitDepHistory: CommitDependencyHistory = {};

  for (const [pluginName, depHistory] of pluginDependencyHistory.entries()) {
    for (const [depName, depData] of Object.entries(depHistory)) {
      if (!combinedDepHistory[depName]) {
        combinedDepHistory[depName] = { history: [] };
      }
      combinedDepHistory[depName].history.push(...depData.history);

      for (const entry of depData.history) {
        const { commitOid, ...rest } = entry;
        if (!commitOid) continue;

        if (!combinedCommitDepHistory[commitOid]) {
          combinedCommitDepHistory[commitOid] = { history: [] };
        }

        combinedCommitDepHistory[commitOid].history.push({
          ...rest,
          depinderDependencyName: depName,
        });
      }
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const homeDir = os.homedir();
  const outputPath = path.join(homeDir, resultsFolder);
  await fs.mkdir(outputPath, {recursive: true});

  await fs.writeFile(
    path.join(outputPath, `dependency-history-${timestamp}.json`),
    JSON.stringify(combinedDepHistory, null, 2),
    'utf8'
  );

  await fs.writeFile(
    path.join(outputPath, `commit-dependency-history-${timestamp}.json`),
    JSON.stringify(combinedCommitDepHistory, null, 2),
    'utf8'
  );
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
        const currentDeps = getDependencyMap(project); // includes version + type
        const previousProject = lastValidProjects.get(projectKey);

        if (!previousProject) {
          // Initial commit for this project, all are ADDED
          for (const [depName, { version, type }] of Object.entries(currentDeps)) {
            if (!pluginHistory[depName]) pluginHistory[depName] = { history: [] };
            pluginHistory[depName].history.push({
              commitOid: entry.commit.oid,
              date: commitDate,
              action: 'ADDED',
              version,
              project: projectKey,
              type
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
  changes: {
    added: [string, { version: string, type: "direct" | "transitive" }][];
    removed: [string, { version: string, type: "direct" | "transitive" }][];
    modified: { dependency: string; from: string; to: string; type: "direct" | "transitive" }[];
  },
  commitOid: string,
  commitDate: string,
  project: string
) {
  for (const [depName, { version, type }] of changes.added) {
    if (!dependencyHistory[depName]) dependencyHistory[depName] = { history: [] };
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: 'ADDED',
      version,
      project,
      type
    });
  }

  for (const [depName, { version, type }] of changes.removed) {
    if (!dependencyHistory[depName]) dependencyHistory[depName] = { history: [] };
    dependencyHistory[depName].history.push({
      commitOid,
      date: commitDate,
      action: 'DELETED',
      version,
      project,
      type
    });
  }

  for (const { dependency, from, to, type } of changes.modified) {
    if (!dependencyHistory[dependency]) dependencyHistory[dependency] = { history: [] };
    dependencyHistory[dependency].history.push({
      commitOid,
      date: commitDate,
      action: 'MODIFIED',
      fromVersion: from,
      toVersion: to,
      project,
      type
    });
  }
}

function getDependencyMap(project: DepinderProject | undefined): Record<string, { version: string, type: "direct" | "transitive" }> {
  if (!project) return {};
  return Object.values(project.dependencies).reduce((map, dep) => {
    const [name] = dep.id.split('@');
    const directDep: boolean =
      !dep.requestedBy ||
      dep.requestedBy.some(it => it.startsWith(`${project.name}@${project.version}`));

    map[name] = {
      version: dep.version,
      type: directDep ? 'direct' : 'transitive'
    };
    return map;
  }, {} as Record<string, { version: string, type: "direct" | "transitive" }>);
}

function identifyDependencyChanges(
  currentDeps: Record<string, { version: string, type: "direct" | "transitive" }>,
  nextDeps: Record<string, { version: string, type: "direct" | "transitive" }>
) {
  const added: [string, { version: string, type: "direct" | "transitive" }][] = [];
  const removed: [string, { version: string, type: "direct" | "transitive" }][] = [];
  const modified: { dependency: string; from: string; to: string; type: "direct" | "transitive" }[] = [];

  for (const dep in currentDeps) {
    if (!nextDeps[dep]) {
      removed.push([dep, currentDeps[dep]]);
    } else if (currentDeps[dep].version !== nextDeps[dep].version) {
      modified.push({
        dependency: dep,
        from: currentDeps[dep].version,
        to: nextDeps[dep].version,
        type: nextDeps[dep].type
      });
    }
  }

  for (const dep in nextDeps) {
    if (!currentDeps[dep]) {
      added.push([dep, nextDeps[dep]]);
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
