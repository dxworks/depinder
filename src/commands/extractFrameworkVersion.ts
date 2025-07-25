import fs from 'fs/promises';
import path from 'path';
import { parseStringPromise } from 'xml2js';
import { Command } from 'commander';

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

function convertToCSV(data: FrameworkVersionPerProject[]): string {
    const headers = ['programmingLanguage', 'frameworkVersion', 'projectFile', 'component', 'group', 'notes'];
    const csvRows = data.map(item =>
        [
            item.programmingLanguage,
            item.frameworkVersion,
            item.projectFile,
            item.component,
            item.group,
            item.notes || ''
        ].map(value => `${value}`).join(',')
    );

    return [headers.join(','), ...csvRows].join('\n');
}

async function extract(rootPath: string): Promise<FrameworkVersionPerProject[]> {
    const results: FrameworkVersionPerProject[] = [];
    const dotNetProjectFiles = await findFiles(rootPath, /.*\.(csproj|vbproj|fsproj)$/);

    for (const projectFile of dotNetProjectFiles) {
        let notes = '';
        let targetFramework = await extractTargetFramework(projectFile);
        const relativePath = path.relative(rootPath, projectFile);
        const component = getComponent(relativePath);

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
        const result = await parseXml(xmlData);

        if (!result || !result.project) {
            console.error('Invalid POM structure');
            return "";
        }

        // Extract properties if they exist
        const properties = result.project.properties?.[0];
        if (properties) {
            if (properties['java.version']) {
                return properties['java.version'][0];
            }
            if (properties['maven.compiler.source']) {
                return properties['maven.compiler.source'][0];
            }
        }

        // Check maven-compiler-plugin configuration
        const build = result.project.build?.[0];
        if (build && build.plugins) {
            for (const plugin of build.plugins) {
                if (plugin.artifactId?.[0] === 'maven-compiler-plugin' && plugin.configuration?.[0]) {
                    const config = plugin.configuration[0];
                    if (config['source']) {
                        return config['source'][0];
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

async function parseXml(xmlData: string) {
    const xmlStart = xmlData.indexOf('<?xml');
    if (xmlStart === -1) {
        return await parseStringPromise(xmlData);
    }

    const cleanXml = xmlData.slice(xmlStart);
    return await parseStringPromise(cleanXml);
}

async function extractTargetFramework(projectFile: string): Promise<string> {
    try {
        const content = await fs.readFile(projectFile, 'utf-8');
        const xml = await parseXml(content);
        const frameworkTags = ['TargetFramework', 'TargetFrameworks', 'TargetFrameworkVersion'];

        const propertyGroups = xml?.Project?.PropertyGroup || [];

        for (const group of propertyGroups) {
            for (const tag of frameworkTags) {
                if (group[tag]) {
                    return group[tag][0];
                }
            }
        }
        return '';
    } catch {
        return '';
    }
}

async function getParameterFromProps(rootPath: string, filePath: string, parameterName: string) {
    let currentDirectory = path.dirname(filePath);
    while (currentDirectory && currentDirectory !== rootPath) {
        const propsFiles = await findFiles(currentDirectory, /\.props$/);
        if (propsFiles.length > 0) {
            const propsFilePath = propsFiles[0];
            const parameterValue = await extractParameterValueFromProps(propsFilePath, parameterName);
            if (parameterValue) {
                return { parameterValue, propsFilePath };
            }
        }
        currentDirectory = path.dirname(currentDirectory);
    }
    throw new Error(`No .props file found from '${filePath}' up to '${rootPath}'.`);
}

async function extractParameterValueFromProps(propsFilePath: string, parameterName: string): Promise<string> {
    try {
        const content = await fs.readFile(propsFilePath, 'utf-8');
        const xml = await parseXml(content);
        const cleanParameterName = parameterName.replace(/[\$()]/g, '');
        return xml?.Project?.PropertyGroup?.[0]?.[cleanParameterName]?.[0] || '';
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
