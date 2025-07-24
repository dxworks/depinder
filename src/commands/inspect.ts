import { Command } from 'commander'
import fs from 'fs'
import path from 'path'
import {DepinderDependency} from '../extension-points/extract'
import {ImportStatement} from '../extension-points/code-impact'
import { log } from '../utils/logging'
import {Plugin} from '../extension-points/plugin'
import {defaultPlugins} from '../extension-points/plugin-loader'
import {readJSON} from '../utils/utils'

export const inspectCommand = new Command('inspect')
    .name('inspect')
    .description('Inspect library usage by looking at import statements')
    .argument('<depinderProjectsPath>', 'Path to DepinderProjects JSON file')
    .argument('<importsPath>', 'Path to Imports JSON file')
    .option('--results, -r', 'The results folder', 'results')
    .action(inspectImports)

interface InspectCommandOptions {
    results: string
}

// Function to match libraries from DepinderProjects with import statements
export function inspectImports(jsonPath: string, importsPath: string, options: InspectCommandOptions): void {
    const resultsFolder = path.resolve(process.cwd(), options.results || 'results')
    if (!fs.existsSync(resultsFolder)) {
        fs.mkdirSync(resultsFolder, {recursive: true})
        log.info('Creating results dir')
    }

    log.info(`Reading DepinderProjects JSON: ${jsonPath}`)
    const depinderDependencies = readJSON<Record<string, Record<string, DepinderDependency>>>(jsonPath)

    log.info(`Reading imports JSON: ${importsPath}`)
    const importData = readJSON<ImportStatement[]>(importsPath)

    log.info('\n--- Matching imports ---')
    const matchedImportsToDependencies: { importStatement: ImportStatement; depinderDependency: DepinderDependency | null }[] = []
    for (const importStatement of importData) {
        const plugin = getPluginFromImportLanguage(importStatement.language)
        if (!plugin) {
            log.error(`No plugin found for language: ${importStatement.language}`)
            continue
        }
        if (!plugin.codeFinder) {
            log.error(`CodeFinder not implemented for plugin: ${plugin.name}`)
            continue
        }
        const depinderDependenciesPluginSpecific = depinderDependencies[plugin.name]
        const matchFunction = plugin.codeFinder.matchImportToLibrary
        matchedImportsToDependencies.push({
            importStatement,
            depinderDependency: matchFunction(importStatement, depinderDependenciesPluginSpecific),
        })
    }

    computeLibraryUsageResults(matchedImportsToDependencies, resultsFolder)
}

function getPluginFromImportLanguage(language: string): Plugin | null {
    const lowerCasedLanguage = language.toLowerCase()
    return defaultPlugins.find(plugin =>
        plugin.name === lowerCasedLanguage || plugin.aliases?.includes(lowerCasedLanguage)
    ) || null
}

type LibraryUsage = {
    nameOfLibrary: string;
    versionOfLibrary: string;
    fileNames: Set<string>;
    projectNames: Set<string>;
    vulnerabilities: string;
};

function computeLibraryUsageResults(
    matches: { importStatement: ImportStatement, depinderDependency: DepinderDependency | null }[],
    resultsFolder: string
) {
    const concernsMap = new Map<string, { strength: number, entity: string, tag: string }>()
    const libraryUsageMap = new Map<string, LibraryUsage>()

    for (const { importStatement, depinderDependency } of matches) {
        if (!depinderDependency) continue

        const { id: libraryId, name, version, vulnerabilities } = depinderDependency
        const filePath = importStatement.file
        const normalizedLibraryId = libraryId.replace(/\./g, '_')
        const concernMapKey = `${filePath}::${normalizedLibraryId}`
        const projectPath = importStatement.projectPath

        const vulnerabilitiesMapped = vulnerabilities?.map(v => `${v.severity} - ${v.permalink}`).join('\n')

        // First result
        let concern = concernsMap.get(concernMapKey)
        if (!concern) {
            concern = {
                strength: 0,
                entity: filePath,
                tag: `library.${normalizedLibraryId}`,
            }
            concernsMap.set(concernMapKey, concern)
        }

        concern.strength++

        // Second & Third results: per-library aggregation
        let usage = libraryUsageMap.get(libraryId)
        if (!usage) {
            usage = {
                nameOfLibrary: name,
                versionOfLibrary: version,
                fileNames: new Set<string>(),
                projectNames: new Set<string>(),
                vulnerabilities: vulnerabilitiesMapped ?? '',
            }
            libraryUsageMap.set(libraryId, usage)
        }
        usage.fileNames.add(filePath)
        usage.projectNames.add(projectPath)
    }

    writeLibraryFileImports(concernsMap, resultsFolder)
    writeLibraryUsageSummary(libraryUsageMap, resultsFolder)
    writeLibraryUsageCsvReport(libraryUsageMap, resultsFolder)

    // Writing the raw matches for debug/reference
    fs.writeFileSync(
        path.resolve(resultsFolder, 'matched-imports-to-dependencies.json'),
        JSON.stringify(matches, null, 2)
    )
}

/**
 * Writes unique library import occurrences per file.
 * Output format:
 *      {"file":
 *          {"concerns":[
 *                  {
 *                  "strength":${number_of_occurences},
 *                  "entity": ${file},
 *                  "tag": `library.${libraryId}` // and in the libraryId where we have '.' we should have '_'
 *                  }
 *              ]
 *          }
 *      }
 */
function writeLibraryFileImports(concernsMap: Map<string, { strength: number, entity: string, tag: string }>, resultsFolder: string) {
    const concerns = Array.from(concernsMap.values())

    const output = {
        file: {
            concerns,
        },
    }

    fs.writeFileSync(
        path.resolve(resultsFolder, 'library-file-imports.json'),
        JSON.stringify(output, null, 2)
    )
}

/**
 * Writes a summary of library usage: number of files and projects, and files list.
 * Output format: {key: idOfLibrary, values:{ number of files imported in, number of projects imported in, files imported in}
 */
function writeLibraryUsageSummary(
    libraryUsageMap: Map<string, LibraryUsage>,
    resultsFolder: string
) {
    const libraryUsageSummary: Record<string, {
        numberOfFilesImportedIn: number;
        numberOfProjectsImportedIn: number;
        filesImportedIn: string[];
    }> = {}

    for (const [libraryId, usage] of libraryUsageMap.entries()) {
        libraryUsageSummary[libraryId] = {
            numberOfFilesImportedIn: usage.fileNames.size,
            numberOfProjectsImportedIn: usage.projectNames.size,
            filesImportedIn: Array.from(usage.fileNames).sort(),
        }
    }

    fs.writeFileSync(
        path.resolve(resultsFolder, 'library-usage-summary.json'),
        JSON.stringify(libraryUsageSummary, null, 2)
    )
}

/**
 * Writes a CSV report of library usage.
 * Output format: name of library | version of library| number of projects | number of files | projects -  each project in a new line
 */
function writeLibraryUsageCsvReport(
    libraryUsageMap: Map<string, LibraryUsage>,
    resultsFolder: string
) {
    const csvRows = [
        'name of library,version of library,vulnerabilities,number of files,number of projects,projects',
    ]

    for (const usage of libraryUsageMap.values()) {
        const projectsMultiline = Array.from(usage.projectNames).sort().join('\n').replace(/"/g, '""')
        csvRows.push(
            `"${usage.nameOfLibrary}","${usage.versionOfLibrary}","${usage.vulnerabilities}",${usage.fileNames.size},${usage.projectNames.size},"${projectsMultiline}"`
        )
    }

    fs.writeFileSync(
        path.resolve(resultsFolder, 'library-usage-report.csv'),
        csvRows.join('\n')
    )
}
