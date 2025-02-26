import git from 'isomorphic-git'
import {DepinderProject} from "../../extension-points/extract"
import {Plugin} from "../../extension-points/plugin"
import minimatch from "minimatch";
import {log} from "../../utils/logging"
import path from "path"
import {depinderTempFolder} from "../../utils/utils"
import {promises as fs} from 'fs'
import {processJavaPlugin} from './java-plugin';

// Function to fetch commits from a Git repository
export async function getCommits(folder: string): Promise<any[]> {
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
export async function processCommitForPlugins(
  commit: any,
  folder: string,
  selectedPlugins: Plugin[],
  commitProjectsMap: Map<string, { commit: any; projects: DepinderProject[] | string }[]>
) {
  const changes = await getChangedFiles(commit, folder);
  await ensureDirectoryExists(depinderTempFolder);

  for (const plugin of selectedPlugins) {
    let filteredFiles = changes
      .filter((file) => (plugin.extractor.filter ? plugin.extractor.filter(file) : true))
      .filter((file) => plugin.extractor.files.some((pattern) => minimatch(file, pattern, {matchBase: true})));

    if (plugin.name === 'npm' && filteredFiles.length > 0) {
      if (filteredFiles.includes('package.json') || filteredFiles.includes('package-lock.json')) {
        if (!filteredFiles.includes('package.json')) {
          filteredFiles.push('package.json');
        }
        if (!filteredFiles.includes('package-lock.json')) {
          filteredFiles.push('package-lock.json');
        }
      }
      const tempFilePaths: string[] = [];
      let allFilesExist = true;

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
          console.error(`Failed to read file ${file} at commit ${commit.oid}:`, error);
          allFilesExist = false;
        }
      }

      if (!allFilesExist) {
        console.log(`Skipping plugin ${plugin.name} for commit ${commit.oid} due to missing files.`);
        if (!commitProjectsMap.has(plugin.name)) {
          commitProjectsMap.set(plugin.name, []);
        }
        commitProjectsMap.get(plugin.name)!.push({
          commit,
          projects: 'error',
        });

        await cleanupTempFiles(tempFilePaths);
        continue;
      }

      const projects: DepinderProject[] = await extractProjects(plugin, tempFilePaths);
      projects.forEach((project) => {
        const dependencyIds = Object.values(project.dependencies)
          .map((dep) => dep.id)
          .join(', ');
        console.log(`Project: ${project.name}, Dependencies: ${dependencyIds}`);
      });

      await cleanupTempFiles(tempFilePaths);

      if (!commitProjectsMap.has(plugin.name)) {
        commitProjectsMap.set(plugin.name, []);
      }
      commitProjectsMap.get(plugin.name)!.push({ commit, projects });
    }

    if (plugin.name === 'java' && filteredFiles.length > 0) {
      let tempFilePaths: string[] = [];
      let projects: DepinderProject[] | string = [];

      try {
        tempFilePaths = await processJavaPlugin(commit, folder, filteredFiles);
        console.log('Temp Java file paths:', tempFilePaths);
        if (!tempFilePaths || tempFilePaths.length === 0) {
          throw new Error('No temp files returned from processJavaPlugin.');
        }
        const parsedProjects = await extractProjects(plugin, tempFilePaths);
        parsedProjects.forEach((project) => {
          const dependencyIds = Object.values(project.dependencies)
            .map((dep) => dep.id)
            .join(', ');
          console.log(`Project: ${project.name}, Dependencies: ${dependencyIds}`);
        });
        projects = parsedProjects;
      } catch (error) {
        console.error(`Error processing Java plugin for commit ${commit.oid}:`, error);
        projects = 'error';
      } finally {
        await cleanupTempFiles(tempFilePaths);
      }
      if (!commitProjectsMap.has(plugin.name)) {
        commitProjectsMap.set(plugin.name, []);
      }
      commitProjectsMap.get(plugin.name)!.push({commit, projects});
    }
  }
}

// Function to get changed files between commits
async function getChangedFiles(commit: any, folder: string): Promise<string[]> {
  const changedFiles: string[] = [];
  const currentCommitOid = commit.oid;
  const parentCommitOid = commit.commit.parent[0];

  try {
    const diff = await git.walk({
      fs,
      dir: folder,
      trees: [git.TREE({ref: currentCommitOid}), git.TREE({ref: parentCommitOid})],
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
    await fs.mkdir(directoryPath, {recursive: true});
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
