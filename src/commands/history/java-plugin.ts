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

  try {
    console.log(`Processing Java plugin for commit ${commit.oid} in folder "${folder}"`);
    await git.checkout({
      fs: nodefs,
      dir: folder,
      ref: commit.oid,
      force: true,
    });
    console.log('Checkout successful.');

    for (const relativeFilePath of filteredFiles) {
      if (!relativeFilePath.endsWith('pom.xml')) continue;

      const pomFile = path.join(folder, relativeFilePath);
      console.log(`Found pom.xml at: ${pomFile}`);

      const projectName = path.basename(path.dirname(pomFile));
      const projectTempFolder = path.join(depinderTempFolder, projectName);
      await fs.mkdir(projectTempFolder, { recursive: true });
      console.log(`Created/verified temp folder for project "${projectName}": ${projectTempFolder}`);

      const tempPomXmlPath = path.join(projectTempFolder, "pom.xml");
      await fs.copyFile(pomFile, tempPomXmlPath);
      console.log(`Copied pom.xml to temp: ${tempPomXmlPath}`);
      result.push(tempPomXmlPath);

      const pomDir = path.dirname(pomFile);
      console.log(`Running Maven command in directory: ${pomDir}`);
      const mavenCommand = 'mvn dependency:tree -DoutputFile=deptree.txt';
      const { stdout, stderr } = await execPromise(mavenCommand, { cwd: pomDir });
      console.log('Maven command output:', stdout);
      if (stderr) {
        console.log('Maven command errors:', stderr);
      }

      const deptreePath = path.join(pomDir, 'deptree.txt');
      console.log(`Verifying existence of deptree file at "${deptreePath}"...`);
      await fs.access(deptreePath);
      console.log('deptree.txt found.');

      const tempDepTreePath = path.join(projectTempFolder, "deptree.txt");
      await fs.copyFile(deptreePath, tempDepTreePath);
      console.log(`Copied deptree.txt to temp: ${tempDepTreePath}`);
      result.push(tempDepTreePath);

      try {
        await fs.unlink(deptreePath);
        console.log(`Deleted original deptree.txt at "${deptreePath}".`);
      } catch (deleteError: any) {
        if (deleteError.code !== 'ENOENT') {
          console.error(`Error deleting deptree.txt at "${deptreePath}":`, deleteError);
        }
      }
    }

    console.log('Process complete. Returning files:', result);
    return result;
  } catch (error) {
    console.error(`Failed to process Java plugin for commit ${commit.oid}:`, error);
    return [];
  }
}
