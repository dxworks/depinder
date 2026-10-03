import {Command} from 'commander'
import {mapWithConcurrency} from '@depinder/core'
import chalk from 'chalk'
import {sharedCacheDb, sqliteCache} from '../cache/sqlite-cache'
import moment from 'moment'
import {getPluginsFromNames} from '../plugins'
import {registryTypeOfPlugin} from '../plugins/sbom'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {Presets, SingleBar} from 'cli-progress'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {log} from '../utils/logging'
import {CacheMaxAgeOptions, cacheMaxAgeSeconds, formatDuration, freshnessCutoffMs} from '../cache/max-age'
import {createRegistryFallback, RegistryFallback} from '../fallback/registry-fallback'
import {REGISTRY_LIMITS_ENV, resolveRegistryLimits} from '../fallback/registry-limits'

export interface UpdateOptions extends CacheMaxAgeOptions {
    /** `npm=16,cargo=1:1000`: per-ecosystem registry limits over `DEPINDER_REGISTRY_LIMITS` and the defaults. */
    registryLimits?: string
}

export const updateCommand = new Command()
    .name('update')
    .description('Re-fetch the local cache\'s libraries last written before a date, by default the expired ones')
    .argument('[updated_before]', 'Update all libs that were updated before this date; '
        + 'when omitted, the ones older than the cache max age')
    .argument('[plugins...]', 'A list of plugins to update database libs for')
    .option('--cache-max-age <duration>',
        'Without a date, re-fetch the libraries older than this: <n>[s|m|h|d]; DEPINDER_CACHE_MAX_AGE when unset, else 1d')
    .option('--registry-limits <limits>',
        'Registry requests at once per ecosystem, with an optional gap in ms: npm=16,cargo=1:1000; '
        + 'over DEPINDER_REGISTRY_LIMITS and the defaults')
    .action(updateLibs)

export async function updateLibs(updated_before: string, plugins: string[], options: UpdateOptions = {}): Promise<void> {
    // Built first, so a bad limit stops the run before anything is read or fetched.
    const registries = createRegistryFallback(resolveRegistryLimits({flag: options.registryLimits, env: process.env[REGISTRY_LIMITS_ENV]}))
    // No date: exactly the entries an analyse run would treat as expired.
    let before: number
    if (updated_before) {
        before = moment(updated_before).valueOf()
    } else {
        const maxAgeSeconds = cacheMaxAgeSeconds(options)
        before = freshnessCutoffMs(maxAgeSeconds)
        log.info(`Updating the libraries older than the cache max age, ${formatDuration(maxAgeSeconds)}`)
    }

    const db = sharedCacheDb()
    log.info(`Local cache: ${chalk.yellow(db.file)}`)
    const ids = db.libKeysUpdatedBefore(before)

    const selectedPlugins = getPluginsFromNames(plugins)

    const idsToUpdate = ids.filter(id => selectedPlugins.some(plugin => id.startsWith(`${ecosystemOf(plugin)}:`)))
    if (idsToUpdate.length > 0) {
        log.info(`Updating ${idsToUpdate.length} of ${ids.length} libraries...`)
        const progressBar = new SingleBar({
            format: 'Updating |' + chalk.green('{bar}') + '| {percentage}% || {value}/{total} Libraries | {plugin} | {library}',
        }, Presets.shades_grey)
        progressBar.start(idsToUpdate.length, 0, {plugin: '', library: ''})
        await updateLibrariesFor(selectedPlugins, idsToUpdate, registries, progressBar)
        progressBar.stop()
    } else {
        log.info('No libraries to update.')
    }
}

/** Each selected ecosystem's ids, under the first plugin claiming it: plugins sharing an ecosystem share cache ids. */
function idsByPlugin(selectedPlugins: Plugin[], idsToUpdate: string[]): Map<Plugin, string[]> {
    const byEcosystem = new Map<string, Plugin>()
    for (const plugin of selectedPlugins) {
        if (!byEcosystem.has(ecosystemOf(plugin))) byEcosystem.set(ecosystemOf(plugin), plugin)
    }
    return new Map([...byEcosystem.values()].map(plugin =>
        [plugin, idsToUpdate.filter(id => id.startsWith(`${ecosystemOf(plugin)}:`))]))
}

/** Re-fetches through the registry fallback `analyse` uses, as many at once per ecosystem as it allows. */
async function updateLibrariesFor(selectedPlugins: Plugin[], idsToUpdate: string[], registries: RegistryFallback, progressBar: SingleBar) {
    await Promise.all([...idsByPlugin(selectedPlugins, idsToUpdate)].map(async ([plugin, ids]) => {
        const type = registryTypeOfPlugin(plugin)
        const prefixLength = ecosystemOf(plugin).length + 1
        await mapWithConcurrency(ids, registries.packagesAtOnce(type), async id => {
            const libraryName = id.substring(prefixLength)
            await updateLibrary(plugin, {type, name: libraryName}, id, registries)
            progressBar.increment({library: libraryName, plugin: plugin.name})
        })
    }))
}

async function updateLibrary(plugin: Plugin, pkg: {type: string, name: string}, id: string, registries: RegistryFallback) {
    try {
        const lib = await registries.lookup(pkg)
        if (plugin.checker?.githubSecurityAdvisoryEcosystem) {
            lib.vulnerabilities = await getVulnerabilitiesFromGithub(plugin.checker.githubSecurityAdvisoryEcosystem, lib.name)
        }
        sqliteCache.set(id, lib)
    } catch (e: any) {
        log.warn(`Exception getting remote info for ${pkg.name}`)
        log.error(e)
    }
}
