import git from 'isomorphic-git';
import * as nodefs from 'fs';
import { promises as fs } from 'fs';
import path from 'path';
import {exec} from 'child_process';
import {promisify} from 'util';
import {depinderTempFolder} from '../../utils/utils';

const execPromise = promisify(exec);

export async function processJavaPlugin(
  commit: any,
  folder: string,
  filteredFiles: string[]
): Promise<string[]> {
  let result: string[];

  const deptreePath = path.join(folder, 'deptree.txt');
  const tempFiles: string[] = [];

  try {
    console.log(`Processing Java plugin for commit ${commit.oid} in folder "${folder}"`);
    console.log(`Checking out commit ${commit.oid} (force mode)...`);
    await git.checkout({
      fs: nodefs,
      dir: folder,
      ref: commit.oid,
      force: true,
    });
    console.log('Checkout successful.');
    for (const filePath of filteredFiles) {
      if (filePath.endsWith('pom.xml')) {
        try {
          console.log(`Reading pom.xml from Git at: ${filePath}`);
          const { blob } = await git.readBlob({
            fs: nodefs,
            dir: folder,
            oid: commit.oid,
            filepath: filePath,
          });
          const tempPomXmlPath = path.join(
            depinderTempFolder,
            `${commit.oid}-${path.basename(filePath)}`
          );
          await fs.writeFile(tempPomXmlPath, blob);
          console.log(tempPomXmlPath);

          tempFiles.push(tempPomXmlPath);
        } catch (readError) {
          console.warn(`Failed to read pom.xml at ${filePath}:`, readError);
        }
      }
    }

    const mavenCommand = 'mvn dependency:tree -DoutputFile=deptree.txt';
    console.log(`Running Maven command: ${mavenCommand}`);
    const { stdout, stderr } = await execPromise(mavenCommand, { cwd: folder });
    console.log('Maven command output:', stdout);
    if (stderr) {
      console.log('Maven command errors:', stderr);
    }

    console.log(`Verifying existence of deptree file at "${deptreePath}"...`);
    await fs.access(deptreePath);
    console.log('deptree.txt found.');

    const tempDepTreePath = path.join(depinderTempFolder, `deptree.txt`);
    console.log(`Copying deptree.txt to temporary file at "${tempDepTreePath}"...`);
    await fs.copyFile(deptreePath, tempDepTreePath);
    console.log('deptree.txt file copied successfully.');

    tempFiles.push(tempDepTreePath);

    result = tempFiles;
    console.log('Process complete. Returning files:', result);

  } catch (error) {
    console.error(`Failed to process Java plugin for commit ${commit.oid}:`, error);
  } finally {
    try {
      await fs.unlink(deptreePath);
      console.log(`Successfully deleted deptree.txt at "${deptreePath}".`);
    } catch (deleteError: any) {
      if (deleteError.code !== 'ENOENT') {
        console.error(`Error deleting deptree.txt at "${deptreePath}":`, deleteError);
      }
    }
  }

  // @ts-ignore
  return result;
}
