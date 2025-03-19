import git from 'isomorphic-git';
import * as nodefs from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { depinderTempFolder } from '../../utils/utils';

const execPromise = promisify(exec);

export async function processJavaPlugin(
  commit: any,
  folder: string,
  filteredFiles: string[]
): Promise<string[]> {
  let result: string[] = [];
  const tempFiles: string[] = [];
  let deptreePath: string | undefined = undefined;

  try {
    console.log(`Processing Java plugin for commit ${commit.oid} in folder "${folder}"`);
    await git.checkout({
      fs: nodefs,
      dir: folder,
      ref: commit.oid,
      force: true,
    });
    console.log('Checkout successful.');

    let pomFile: string | null = null;
    for (const filePath of filteredFiles) {
      if (filePath.endsWith('pom.xml')) {
        pomFile = path.join(folder, filePath);
        console.log(`Found pom.xml at: ${pomFile}`);
        break;
      }
    }

    if (!pomFile) {
      console.error(`No pom.xml found in filteredFiles for commit ${commit.oid}.`);
      return [];
    }

    const tempPomXmlPath = path.join(depinderTempFolder, "pom.xml");
    try {
      await fs.copyFile(pomFile, tempPomXmlPath);
      console.log(`Copied pom.xml to temp: ${tempPomXmlPath}`);
      tempFiles.push(tempPomXmlPath);
    } catch (copyError) {
      console.error(`Failed to copy pom.xml:`, copyError);
      return [];
    }

    const pomDir = path.dirname(pomFile);
    console.log(`Running Maven command in directory: ${pomDir}`);

    const mavenCommand = 'mvn dependency:tree -DoutputFile=deptree.txt';
    console.log(`Running Maven command: ${mavenCommand}`);
    const { stdout, stderr } = await execPromise(mavenCommand, { cwd: pomDir });
    console.log('Maven command output:', stdout);
    if (stderr) {
      console.log('Maven command errors:', stderr);
    }

    deptreePath = path.join(pomDir, 'deptree.txt');
    console.log(`Verifying existence of deptree file at "${deptreePath}"...`);
    await fs.access(deptreePath);
    console.log('deptree.txt found.');

    const tempDepTreePath = path.join(depinderTempFolder, "deptree.txt");
    console.log(`Copying deptree.txt to temporary file at "${tempDepTreePath}"...`);
    await fs.copyFile(deptreePath, tempDepTreePath);
    console.log('deptree.txt file copied successfully.');
    tempFiles.push(tempDepTreePath);

    result = tempFiles;
    console.log('Process complete. Returning files:', result);
  } catch (error) {
    console.error(`Failed to process Java plugin for commit ${commit.oid}:`, error);
    return [];
  } finally {
    if (deptreePath) {
      try {
        await fs.unlink(deptreePath);
        console.log(`Successfully deleted deptree.txt at "${deptreePath}".`);
      } catch (deleteError: any) {
        if (deleteError.code !== 'ENOENT') {
          console.error(`Error deleting deptree.txt at "${deptreePath}":`, deleteError);
        }
      }
    }
  }

  return result;
}
