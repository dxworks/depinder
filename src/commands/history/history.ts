import {Command} from 'commander'
import {AnalyseOptions} from '../analyse'
import {getPluginsFromNames} from '../../plugins'
import {DependencyFileContext, DepinderProject} from '../../extension-points/extract'

export const historyCommand = new Command()
    .name('history')
    .argument('[folders...]', 'A list of git repositories to analyse')
    // .argument('[depext-files...]', 'A list of files to parse for dependency information')
    .option('--results, -r', 'The results folder', 'results')
    .option('--refresh', 'Refresh the cache', false)
    .option('--plugins, -p [plugins...]', 'A list of plugins')
    .action(analyseHistory)


export async function analyseHistory(folders: string[], options: AnalyseOptions, useCache = true): Promise<void> {
    const selectedPlugins = getPluginsFromNames(options.plugins)

    // folders.map(repo => {
    //     console.log(`Analysing ${repo} with isomorphic Git`)
    //     const commits: any[] = []
    //     commits.forEach(commit => {
    //         const changes: any[] = []
    //         const files = changes
    //             .filter(it => plugin.extractor.filter ? plugin.extractor.filter(it) : true)
    //             .filter(it => plugin.extractor.files
    //                 .some(pattern => minimatch(it, pattern, {matchBase: true}))
    //             )
    //     })
    // })

    const projects: DepinderProject[] =
        await Promise.all(selectedPlugins.map(async (plugin: any) => {
        console.log(`Running plugin ${plugin.name}`)
        const context: DependencyFileContext = {} as DependencyFileContext
        return await plugin.parser?.parseDependencyTree(context)
    }))
}

class Repo {

}

class Commit {

}

class Change {

}

