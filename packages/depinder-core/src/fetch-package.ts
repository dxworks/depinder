import type {ParsedPurl} from './purl.js'
import {fetcherFor} from './registries/index.js'
import {computeLatest} from './registries/latest.js'
import type {FetchContext, ResolvedPackage} from './registries/types.js'

/** Whether core has a fetcher for this purl type. */
export function canFetch(type: string): boolean {
    return fetcherFor(type) !== undefined
}

/**
 * All facts about one package, from its registry of record, with the latest rule already applied:
 * the one way into the fetchers, so no caller can skip the rule. `null` means the registry
 * answered "no such package"; anything else that is not a usable answer throws.
 */
export async function fetchPackage(key: ParsedPurl, ctx: FetchContext): Promise<ResolvedPackage | null> {
    const fetcher = fetcherFor(key.type)
    if (!fetcher) throw new Error(`no registry implemented for type "${key.type}"`)
    const fetched = await fetcher.fetchPackage(key, ctx)
    if (!fetched) return null
    const {latest, latestPrerelease} = computeLatest(key.type, fetched.versions, fetched.registryLatest)
    return {...fetched, latest, latestPrerelease}
}
