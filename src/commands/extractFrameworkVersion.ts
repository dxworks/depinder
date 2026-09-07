import fs from 'fs/promises';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';
import { Command } from 'commander';
import { stringify } from 'csv-stringify/sync';

interface FrameworkVersionPerProject {
    programmingLanguage: string;
    projectFile: string;
    frameworkVersion: string;
    component: string;
    group: string;
    notes?: string;
}

async function extractFrameworkVersions(rootPath: string, outputPath: string) {
    const projectVersions = await extract(rootPath);
    projectVersions.sort((a, b) => a.projectFile.localeCompare(b.projectFile));
    const csvContent = convertToCSV(projectVersions);
    await fs.writeFile(outputPath, csvContent, 'utf-8');
}

export function convertToCSV(data: FrameworkVersionPerProject[]): string {
    const headers = ['programmingLanguage', 'frameworkVersion', 'projectFile', 'component', 'group', 'notes'];
    const rows = data.map(item => [
            item.programmingLanguage,
            item.frameworkVersion,
            item.projectFile,
            item.component,
            item.group,
            item.notes || ''
        ]);

    return stringify([headers, ...rows]);
}

export async function extract(rootPath: string): Promise<FrameworkVersionPerProject[]> {
    const results: FrameworkVersionPerProject[] = [];
    const dotNetProjectFiles = await findFiles(rootPath, /.*\.(csproj|vbproj|fsproj)$/);

    for (const projectFile of dotNetProjectFiles) {
        let notes = '';
        let targetFramework = await extractTargetFramework(projectFile);
        const relativePath = path.relative(rootPath, projectFile);
        const component = getComponent(relativePath);

        if (!targetFramework) {
            const propsResult = await extractTargetFrameworkFromProps(rootPath, projectFile);
            targetFramework = propsResult.targetFramework;
            notes = propsResult.propsFilePath;
        }

        if (targetFramework.startsWith('$')) {
            const { parameterValue, propsFilePath } = await getParameterFromProps(rootPath, projectFile, targetFramework);
            targetFramework = parameterValue;
            notes = propsFilePath;
        }

        results.push({
            programmingLanguage: '.NET',
            projectFile: relativePath,
            frameworkVersion: targetFramework,
            component,
            group: component,
            notes,
        });
    }

    const mavenFiles = await findFiles(rootPath, /pom\.xml$/);
    for (const mavenFile of mavenFiles) {
        const javaVersion = await extractJavaVersionFromMaven(mavenFile);

        const relativePath = path.relative(rootPath, mavenFile);
        const component = getComponent(relativePath);
        results.push({
            programmingLanguage: 'JAVA',
            projectFile: relativePath,
            frameworkVersion: javaVersion,
            component,
            group: component,
            notes: 'Extracted from pom.xml',
        });

    }

    const gradleFiles = await findFiles(rootPath, /build\.gradle$/);
    for (const gradleFile of gradleFiles) {
        const javaVersion = await extractJavaVersionFromGradle(gradleFile);

        const relativePath = path.relative(rootPath, gradleFile);
        const component = getComponent(relativePath);
        results.push({
            programmingLanguage: 'JAVA',
            projectFile: relativePath,
            frameworkVersion: javaVersion,
            component,
            group: component,
            notes: 'Extracted from build.gradle',
        });

    }

    const pipfiles = await findFiles(rootPath, /^Pipfile$/);
    for (const pipfile of pipfiles) {
        const pythonVersion = await extractPythonVersionFromPipfile(pipfile);

        const relativePath = path.relative(rootPath, pipfile);
        const component = getComponent(relativePath);
        results.push({
            programmingLanguage: 'PYTHON',
            projectFile: relativePath,
            frameworkVersion: pythonVersion,
            component,
            group: component,
            notes: 'Extracted from Pipfile',
        });
    }

    return results;
}

async function extractPythonVersionFromPipfile(pipfilePath: string): Promise<string> {
    try {
        const content = await fs.readFile(pipfilePath, 'utf-8');
        // Look for a line like: python_version = "3.11"
        const match = content.match(/python_version\s*=\s*["']([\d.]+)["']/);
        if (match) {
            return match[1];
        }
        return '';
    } catch {
        return '';
    }
}

async function extractJavaVersionFromGradle(gradleFilePath: string): Promise<string> {
    const gradleContent = await fs.readFile(gradleFilePath, 'utf-8');

    const matchToolchain = gradleContent.match(/java\s*\{[^}]*?languageVersion\.set\(JavaLanguageVersion\.of\((\d+(?:\.\d+)?)\)\)/s);
    if (matchToolchain) return matchToolchain[1];

    const matchSourceCompatibility = gradleContent.match(/sourceCompatibility\s*[=:]\s*['"]?(\d+(?:\.\d+)?)['"]?/);
    if (matchSourceCompatibility) return matchSourceCompatibility[1];

    const matchTargetCompatibility = gradleContent.match(/targetCompatibility\s*[=:]\s*['"]?(\d+(?:\.\d+)?)['"]?/);
    if (matchTargetCompatibility) return matchTargetCompatibility[1];

    return '';
}

async function extractJavaVersionFromMaven(pomFilePath: string): Promise<string> {
    try {
        const xmlData = await fs.readFile(pomFilePath, 'utf-8');
        const result = parseXml(xmlData);

        if (!result || !result.project) {
            console.error('Invalid POM structure');
            return "";
        }

        // Extract properties if they exist
        const properties = result.project.properties;
        if (properties) {
            if (properties['java.version']) {
                return String(properties['java.version']);
            }
            if (properties['maven.compiler.source']) {
                return String(properties['maven.compiler.source']);
            }
        }

        // Check maven-compiler-plugin configuration
        const build = result.project.build;
        if (build && build.plugins) {
            const plugins = Array.isArray(build.plugins.plugin) ? build.plugins.plugin : [build.plugins.plugin];
            for (const plugin of plugins) {
                if (plugin?.artifactId === 'maven-compiler-plugin' && plugin.configuration) {
                    const config = plugin.configuration;
                    if (config['source']) {
                        return String(config['source']);
                    }
                }
            }
        }

        return ""; // Return empty string if Java version not found
    } catch (error) {
        console.error('Error reading or parsing POM file:', error);
        return "";
    }
}

function parseXml(xmlData: string) {
    // Remove multi-line comments from the entire file
    const withoutComments = xmlData.replace(/\/\*[\s\S]*?\*\//g, '');

    // Remove empty lines and whitespace from the beginning of the file only
    const trimmedXml = withoutComments.replace(/^\s*[\r\n]+/, '');

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
    });
    return parser.parse(trimmedXml);
}

export async function extractTargetFramework(projectFile: string): Promise<string> {
    try {
        const content = await fs.readFile(projectFile, 'utf-8');
        const xml = parseXml(content);
        const frameworkTags = ['TargetFramework', 'TargetFrameworks', 'TargetFrameworkVersion'];

        const propertyGroupData = xml?.Project?.PropertyGroup;
        const propertyGroups = Array.isArray(propertyGroupData) ? propertyGroupData : (propertyGroupData ? [propertyGroupData] : []);

        const targetFrameworks: string[] = [];
        for (const group of propertyGroups) {
            for (const tag of frameworkTags) {
                if (group[tag]) {
                    targetFrameworks.push(...getXmlValues(group[tag]));
                }
            }
        }
        return targetFrameworks.join(' | ');
    } catch (error) {
        console.error(`Error extracting target framework from ${projectFile}:`, error);
        return '';
    }
}

async function extractTargetFrameworkFromProps(rootPath: string, projectFile: string): Promise<{ targetFramework: string; propsFilePath: string }> {
    const result = await findInParentProps(rootPath, projectFile, async propsFilePath => {
        const targetFramework = await extractTargetFramework(propsFilePath);
        return targetFramework || undefined;
    });

    return result
        ? { targetFramework: result.value, propsFilePath: result.propsFilePath }
        : { targetFramework: '', propsFilePath: '' };
}

async function getParameterFromProps(rootPath: string, filePath: string, parameterName: string) {
    const result = await findInParentProps(rootPath, filePath, propsFilePath =>
        extractParameterValueFromProps(propsFilePath, parameterName)
    );

    if (result) {
        return { parameterValue: result.value, propsFilePath: result.propsFilePath };
    }
    throw new Error(`No .props file found from '${filePath}' up to '${rootPath}'.`);
}

async function findInParentProps<T>(rootPath: string, projectFile: string, findValue: (propsFilePath: string) => Promise<T | undefined>): Promise<{ value: T; propsFilePath: string } | undefined> {
    const rootDirectory = path.resolve(rootPath);
    let currentDirectory = path.dirname(projectFile);

    while (currentDirectory) {
        const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
        const propsFiles = entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.props'))
            .map(entry => path.join(currentDirectory, entry.name))
            .sort();

        for (const propsFilePath of propsFiles) {
            const value = await findValue(propsFilePath);
            if (value) {
                return { value, propsFilePath };
            }
        }

        if (currentDirectory === rootDirectory) break;
        const parentDirectory = path.dirname(currentDirectory);
        if (parentDirectory === currentDirectory) break;
        currentDirectory = parentDirectory;
    }
    return undefined;
}

function getXmlValues(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.flatMap(getXmlValues);
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return [String(value)];
    }
    if (value && typeof value === 'object' && '#text' in value) {
        return getXmlValues(value['#text']);
    }
    return [];
}

async function extractParameterValueFromProps(propsFilePath: string, parameterName: string): Promise<string> {
    try {
        const content = await fs.readFile(propsFilePath, 'utf-8');
        const xml = parseXml(content);
        const cleanParameterName = parameterName.replace(/[\$()]/g, '');
        const propertyGroupData = xml?.Project?.PropertyGroup;
        const propertyGroup = Array.isArray(propertyGroupData) ? propertyGroupData[0] : propertyGroupData;
        const value = propertyGroup?.[cleanParameterName];
        return value ? String(value) : '';
    } catch {
        return '';
    }
}

async function findFiles(directory: string, pattern: RegExp): Promise<string[]> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    let files: string[] = [];
    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(await findFiles(fullPath, pattern));
        } else if (pattern.test(entry.name)) {
            files.push(fullPath);
        }
    }
    return files;
}

function getComponent(relativePath: string): string {
    return relativePath.split(path.sep)[0];
}

export const extractFrameworkVersionsCommand = new Command()
    .command('extractFrameworkVersion')
    .description('Extracts .NET framework and Java language versions from a *proj files, Maven and Gradle files')
    .argument('<projectPath>', 'Path to the root directory')
    .argument('<outputPath>', 'Path to save the extracted versions in CSV format')
    .action(extractFrameworkVersions);
