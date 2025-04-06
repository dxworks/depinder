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
    .action(inspectImports)

// Function to match libraries from DepinderProjects with import statements
export function inspectImports(jsonPath: string, importsPath: string): void {
    log.info(`Reading DepinderProjects JSON: ${jsonPath}`)
    const depinderDependencies = readJSON<Record<string, Record<string, DepinderDependency>>>(jsonPath)

    log.info(`Reading imports JSON: ${importsPath}`)
    const importData = readJSON<ImportStatement[]>(importsPath)

    log.info('\n--- Matching imports ---')
    const matches: { importStatement: ImportStatement; depinderDependency: DepinderDependency | null }[] = []
    for (const importStatement of importData) {
        const plugin = getPluginFromImportLanguage(importStatement.language)
        if (!plugin) {
            console.error(`No plugin found for language: ${importStatement.language}`)
            continue
        }
        if (!plugin.codeFinder) {
            console.error(`CodeFinder not implemented for plugin: ${plugin.name}`)
            continue
        }
        const depinderDependenciesPluginSpecific = depinderDependencies[plugin.name]
        const matchFunction = plugin.codeFinder.matchImportToLibrary
        matches.push({
            importStatement,
            depinderDependency: matchFunction(importStatement, depinderDependenciesPluginSpecific),
        })
    }

    const outputPath = path.resolve(process.cwd(), 'inspection-results-meetvent.json')
    fs.writeFileSync(outputPath, JSON.stringify(matches, null, 2))
    log.info(`\nResults saved to: ${outputPath}`)
}

function getPluginFromImportLanguage(language: string): Plugin | null {
    const lowerCasedLanguage = language.toLowerCase()
    return defaultPlugins.find(plugin =>
        plugin.name === lowerCasedLanguage || plugin.aliases?.includes(lowerCasedLanguage)
    ) || null
}
