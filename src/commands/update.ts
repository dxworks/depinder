import {Command} from 'commander'
import {log} from '@dxworks/cli-common'
import chalk from 'chalk'
import {getMongoDockerContainerStatus} from './cache'
import {LibraryInfoModel, mongoCacheLibrary} from '../cache/mongo-cache'
import moment, {Moment} from 'moment'
import {getPluginsFromNames} from '../plugins'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Presets, SingleBar} from 'cli-progress'
import {Plugin} from '../extension-points/plugin'

export const updateCommand = new Command()
    .name('update')
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

    const status = getMongoDockerContainerStatus()
    if (status !== 'running') {
        log.info(chalk.red('Mongo Cache is not running properly.'))
        log.info(`To start Mongo cache run: ${chalk.yellow('depinder cache up')}`)
        return
    }


    const lastUpdateMoment = updated_before ? moment(updated_before) : moment().subtract(1, 'month')

    mongoCacheLibrary.load()

    const ids = await getLibraryIdsToUpdate(lastUpdateMoment)

    const selectedPlugins = getPluginsFromNames(plugins)

    const idsToUpdate = ids.filter(id => selectedPlugins.some(plugin => id.startsWith(`${plugin.name}:`)))
    if (idsToUpdate.length > 0) {
        log.info(`Updating ${idsToUpdate.length} of ${ids.length} libraries...`)
        await updateLibrariesAndLogProcess(idsToUpdate, selectedPlugins)
    } else {
        log.info('No libraries to update.')
    }

    mongoCacheLibrary.write()
}

async function getLibraryIdsToUpdate(lastUpdateMoment: Moment): Promise<string[]> {
    try {
        const query = {updatedAt: {$lt: lastUpdateMoment.toDate()}}

        const docs = await LibraryInfoModel.find(query, '_id')
        return docs.map(doc => doc._id.toString())
    } catch (err) {
        log.error('Error while searching for libraries to update in cache: ', err)
        return []
    }
}

async function updateLibrariesFor(selectedPlugins: Plugin[], idsToUpdate: string[], progressBar: SingleBar) {
    for (const plugin of selectedPlugins) {
        const libsToUpdate = idsToUpdate.filter(id => id.startsWith(`${plugin.name}:`))

        if (libsToUpdate.length > 0) {
            for (const id of libsToUpdate) {
                const libraryName = id.substring(plugin.name.length + 1)
                try {
                    const lib = await plugin.registrar.retrieve(libraryName)
                    if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
                        lib.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name)
                    }
                    await mongoCacheLibrary.set?.(id, lib)
                } catch (e: any) {
                    log.warn(`Exception getting remote info for ${libraryName}`)
                    log.error(e)
                }
                progressBar.increment({library: libraryName, plugin: plugin.name})
            }
        }
    }
}
