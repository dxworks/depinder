import {Command} from 'commander'
import chalk from 'chalk'
import {sharedCacheDb, sqliteCache} from '../cache/sqlite-cache'
import moment from 'moment'
import {getPluginsFromNames} from '../plugins'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Presets, SingleBar} from 'cli-progress'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {log} from '../utils/logging'

export const updateCommand = new Command()
    .name('update')
    .description('Re-fetch the local cache\'s libraries last written before a date')
    .argument('[updated_before]', 'Update all libs that were updated before this date')
    .argument('[plugins...]', 'A list of plugins to update database libs for')
    .action(updateLibs)

async function updateLibrariesAndLogProcess(idsToUpdate: string[], selectedPlugins: Plugin[]) {
    const progressBar = new SingleBar({
        format: 'Updating |' + chalk.green('{bar}') + '| {percentage}% || {value}/{total} Libraries | {plugin} | {library}',
    }, Presets.shades_grey)
    progressBar.start(idsToUpdate.length, 0, {plugin: '', library: ''})
    await updateLibrariesFor(selectedPlugins, idsToUpdate, progressBar)
    progressBar.stop()
}

export async function updateLibs(updated_before: string, plugins: string[]): Promise<void> {
    const lastUpdateMoment = updated_before ? moment(updated_before) : moment().subtract(1, 'month')

    const db = sharedCacheDb()
    log.info(`Local cache: ${chalk.yellow(db.file)}`)
    const ids = db.libKeysUpdatedBefore(lastUpdateMoment.valueOf())

    const selectedPlugins = getPluginsFromNames(plugins)

    const idsToUpdate = ids.filter(id => selectedPlugins.some(plugin => id.startsWith(`${ecosystemOf(plugin)}:`)))
    if (idsToUpdate.length > 0) {
        log.info(`Updating ${idsToUpdate.length} of ${ids.length} libraries...`)
        await updateLibrariesAndLogProcess(idsToUpdate, selectedPlugins)
    } else {
        log.info('No libraries to update.')
    }
}

async function updateLibrariesFor(selectedPlugins: Plugin[], idsToUpdate: string[], progressBar: SingleBar) {
    // One plugin per ecosystem: plugins sharing an ecosystem (a plugins.json plugin reusing a
    // default one's) share cache ids, so iterating all of them would refresh every id once per
    // plugin claiming that prefix.
    const byEcosystem = new Map<string, Plugin>()
    for (const plugin of selectedPlugins) {
        if (!byEcosystem.has(ecosystemOf(plugin))) byEcosystem.set(ecosystemOf(plugin), plugin)
    }

    for (const plugin of byEcosystem.values()) {
        const ecosystem = ecosystemOf(plugin)
        const libsToUpdate = idsToUpdate.filter(id => id.startsWith(`${ecosystem}:`))

        if (libsToUpdate.length > 0) {
            for (const id of libsToUpdate) {
                const libraryName = id.substring(ecosystem.length + 1)
                try {
                    const lib = await plugin.registrar.retrieve(libraryName)
                    if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
                        lib.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name)
                    }
                    sqliteCache.set(id, lib)
                } catch (e: any) {
                    log.warn(`Exception getting remote info for ${libraryName}`)
                    log.error(e)
                }
                progressBar.increment({library: libraryName, plugin: plugin.name})
            }
        }
    }
}
