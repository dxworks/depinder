import {Command} from 'commander'
import {fromRegistryName, mapWithConcurrency, versionPurl} from '@depinder/core'
import chalk from 'chalk'
import {sharedCacheDb, sqliteCache} from '../cache/sqlite-cache'
import moment from 'moment'
import {getPluginsFromNames} from '../plugins'
import {attachGithubAdvisories} from '../utils/library-advisories'
import {Presets, SingleBar} from 'cli-progress'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {DepinderDependency} from '../extension-points/extract'
import {log} from '../utils/logging'
import {CacheMaxAgeOptions, cacheMaxAgeSeconds, formatDuration, freshnessCutoffMs} from '../cache/max-age'
import {createRegistryFallback, RegistryFallback} from '../fallback/registry-fallback'
import {REGISTRY_LIMITS_ENV, resolveRegistryLimits} from '../fallback/registry-limits'
import {logLookupFailure, refetchLookupName} from '../fallback/lookup-name'
import {DEFAULT_RESOLVER_URL, ResolverOptions, resolverConfig} from '../resolver/config'
import {resetResolverClient} from '../resolver/client'
import {bulkResolve, PluginProjects} from '../resolver/bulk-resolve'
import {resetBulkResolve} from '../resolver/bulk-memory'

export interface UpdateOptions extends ResolverOptions, CacheMaxAgeOptions {
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
    .option('--resolver-url <url>',
        'Base URL of the bulk purl resolver, asked before the registries; DEPINDER_RESOLVER_URL when unset, '
        + `else ${DEFAULT_RESOLVER_URL}. Needs DEPINDER_RESOLVER_TOKEN`)
    .option('--no-resolver', 'Do not call the bulk resolver; re-fetch every library from the registries')
    .option('--registry-limits <limits>',
        'Registry requests at once per ecosystem, with an optional gap in ms: npm=16,cargo=1:1000; '
        + 'over DEPINDER_REGISTRY_LIMITS and the defaults')
    .action(updateLibs)

export async function updateLibs(updated_before: string, plugins: string[], options: UpdateOptions = {}): Promise<void> {
    // Built first, so a bad limit stops the run before anything is read or fetched.
    const registries = createRegistryFallback(resolveRegistryLimits({flag: options.registryLimits, env: process.env[REGISTRY_LIMITS_ENV]}))
    const before = staleBeforeMs(updated_before, options)

    const db = sharedCacheDb()
    log.info(`Local cache: ${chalk.yellow(db.file)}`)
    const ids = db.libKeysUpdatedBefore(before)

    const selectedPlugins = getPluginsFromNames(plugins)

    const idsToUpdate = ids.filter(id => selectedPlugins.some(plugin => id.startsWith(`${ecosystemOf(plugin)}:`)))
    if (idsToUpdate.length === 0) {
        log.info('No libraries to update.')
        return
    }
    log.info(`Updating ${idsToUpdate.length} of ${ids.length} libraries...`)
    const staleByPlugin = idsByPlugin(selectedPlugins, idsToUpdate)
    const resolved = await resolveStaleRows(staleByPlugin, options, before)
    const leftByPlugin = new Map([...staleByPlugin].map(([plugin, pluginIds]) =>
        [plugin, pluginIds.filter(id => !resolved.has(id))]))
    const left = idsToUpdate.length - resolved.size
    if (left === 0) return

    if (resolved.size > 0) log.info(`Re-fetching the other ${left} from the registries`)
    const progressBar = new SingleBar({
        format: 'Updating |' + chalk.green('{bar}') + '| {percentage}% || {value}/{total} Libraries | {plugin} | {library}',
    }, Presets.shades_grey)
    progressBar.start(left, 0, {plugin: '', library: ''})
    await updateLibrariesFor(leftByPlugin, registries, progressBar)
    progressBar.stop()
}

/** The given date, or with none exactly the cutoff an analyse run would treat as expired. */
function staleBeforeMs(updatedBefore: string, options: CacheMaxAgeOptions): number {
    if (updatedBefore) return moment(updatedBefore).valueOf()
    const maxAgeSeconds = cacheMaxAgeSeconds(options)
    log.info(`Updating the libraries older than the cache max age, ${formatDuration(maxAgeSeconds)}`)
    return freshnessCutoffMs(maxAgeSeconds)
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

/**
 * `analyse`'s bulk phase over the stale rows: one ask of the resolver, each answer written back
 * under its row. Returns the cache keys it rewrote; the rest go to the registries.
 */
async function resolveStaleRows(staleByPlugin: Map<Plugin, string[]>, options: ResolverOptions, before: number): Promise<Set<string>> {
    const configured = resolverConfig(options)
    if (!configured) return new Set()
    // As with `analyse --refresh`: only facts the server confirmed since the cutoff are taken.
    const resolver = {...configured, freshAfterMs: Math.min(before, Date.now())}
    log.info(`Bulk resolver: ${resolver.url}, waiting at most ${Math.round(resolver.maxWaitMs / 1000)}s for it`)
    resetResolverClient()
    resetBulkResolve()
    const outcome = await bulkResolve(resolver, staleRowsAsProjects(staleByPlugin), sqliteCache, {refresh: true})
    return outcome.written
}

/** The stale rows as one project per plugin, each dependency named by its row so answers land there. */
function staleRowsAsProjects(staleByPlugin: Map<Plugin, string[]>): PluginProjects[] {
    return [...staleByPlugin].map(([plugin, ids]) => {
        const dependencies = Object.fromEntries(ids.map(id => [id, staleRowAsDependency(plugin, id)]))
        return {plugin, projects: [{name: 'cache', version: '', path: '', dependencies}]}
    })
}

function staleRowAsDependency(plugin: Plugin, id: string): DepinderDependency {
    const type = plugin.purlType
    const name = id.substring(ecosystemOf(plugin).length + 1)
    const cached = sharedCacheDb().getLib(id)
    const version = cached?.versions.find(it => it.latest)?.version ?? ''
    const purl = stalePurl(type, refetchLookupName(type, name, cached?.name), version)
    return {id, name, version, requestedBy: [], purl}
}

/** The resolver answers per package, so the version only decorates the purl; none for a name it cannot spell. */
function stalePurl(type: string, registryName: string, version: string): string | undefined {
    try {
        const {packageKey} = fromRegistryName(type, registryName)
        return version ? versionPurl(packageKey, version) : packageKey
    } catch {
        return undefined
    }
}

/** Re-fetches through the registry fallback `analyse` uses, as many at once per ecosystem as it allows. */
async function updateLibrariesFor(idsByPlugin: Map<Plugin, string[]>, registries: RegistryFallback, progressBar: SingleBar) {
    await Promise.all([...idsByPlugin].map(async ([plugin, ids]) => {
        const type = plugin.purlType
        const prefixLength = ecosystemOf(plugin).length + 1
        await mapWithConcurrency(ids, registries.packagesAtOnce(type), async id => {
            const libraryName = id.substring(prefixLength)
            const lookupName = refetchLookupName(type, libraryName, sharedCacheDb().getLib(id)?.name)
            await updateLibrary(plugin, {type, name: lookupName}, id, registries)
            progressBar.increment({library: libraryName, plugin: plugin.name})
        })
    }))
}

async function updateLibrary(plugin: Plugin, pkg: {type: string, name: string}, id: string, registries: RegistryFallback) {
    try {
        const lib = await registries.lookup(pkg)
        await attachGithubAdvisories(lib, plugin)
        sqliteCache.set(id, lib)
    } catch (e: any) {
        logLookupFailure(pkg.name, ecosystemOf(plugin), e)
    }
}
