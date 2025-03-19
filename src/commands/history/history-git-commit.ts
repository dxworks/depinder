import git from 'isomorphic-git'
import {DepinderProject} from "../../extension-points/extract"
import {Plugin} from "../../extension-points/plugin"
import minimatch from "minimatch";
import {log} from "../../utils/logging"
import path from "path"
import {depinderTempFolder} from "../../utils/utils"
import {promises as fs} from 'fs'
import {processJavaPlugin} from './java-plugin'

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

  const tempFilePathsMap = new Map<string, string[]>(); // Store temp files per plugin

  for (const plugin of selectedPlugins) {
    let filteredFiles = changes
      .filter((file) => (plugin.extractor.filter ? plugin.extractor.filter(file) : true))
      .filter((file) => plugin.extractor.files.some((pattern) => minimatch(file, pattern, { matchBase: true })));

    if (filteredFiles.length > 0) {
      let tempFilePaths: string[] = [];

      try {
        if (plugin.name === 'npm') {
          if (filteredFiles.includes('package.json') || filteredFiles.includes('package-lock.json')) {
            if (!filteredFiles.includes('package.json')) {
              filteredFiles.push('package.json');
            }
            if (!filteredFiles.includes('package-lock.json')) {
              filteredFiles.push('package-lock.json');
            }
          }

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
            }
          }
        } else if (plugin.name === 'java') {
          tempFilePaths = await processJavaPlugin(commit, folder, filteredFiles);
          if (!tempFilePaths || tempFilePaths.length === 0) {
            throw new Error('No temp files returned from processJavaPlugin.');
          }
        }

        // Store temp file paths for later extraction
        tempFilePathsMap.set(plugin.name, tempFilePaths);
      } catch (error) {
        console.error(`Error processing plugin ${plugin.name} for commit ${commit.oid}:`, error);
        tempFilePathsMap.set(plugin.name, ['error']);
      }
    }
  }

  // Now, extract projects for all plugins after handling temp files
  for (const [pluginName, tempFilePaths] of tempFilePathsMap.entries()) {
    let projects: DepinderProject[] | string = [];

    if (tempFilePaths[0] !== 'error' && tempFilePaths.length > 0) {
      try {
        console.log(`Extracting projects for plugin ${pluginName}...`);
        projects = await extractProjects(selectedPlugins.find((p) => p.name === pluginName)!, tempFilePaths);
      } catch (error) {
        console.error(`Error extracting projects for ${pluginName}:`, error);
        projects = 'error';
      }
    }

    if (!commitProjectsMap.has(pluginName)) {
      commitProjectsMap.set(pluginName, []);
    }
    commitProjectsMap.get(pluginName)!.push({ commit, projects });

    // Cleanup temp files after extraction
    await cleanupTempFiles(tempFilePaths);
  }
}

// Function to get changed files between commits
async function getChangedFiles(commit: any, folder: string): Promise<string[]> {
  const changedFiles: string[] = [];
  const currentCommitOid = commit.oid;
  const parentCommitOids = commit.commit.parent;

  try {
    if (parentCommitOids.length === 0) {
      return await git.listFiles({fs, dir: folder, ref: currentCommitOid});
    }

    const parentCommitOid = parentCommitOids[0];

    await git.walk({
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
      },
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
