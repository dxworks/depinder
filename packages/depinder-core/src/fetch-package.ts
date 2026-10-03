import type {ParsedPurl} from './purl.js'
import {fetcherFor} from './registries/index.js'
import type {FetchContext, FetchedPackage} from './registries/types.js'

/** Whether core has a fetcher for this purl type. */
export function canFetch(type: string): boolean {
    return fetcherFor(type) !== undefined
}

/**
 * All facts about one package, from its registry of record. `null` means the registry answered
 * "no such package"; anything else that is not a usable answer throws.
 */
export async function fetchPackage(key: ParsedPurl, ctx: FetchContext): Promise<FetchedPackage | null> {
    const fetcher = fetcherFor(key.type)
    if (!fetcher) throw new Error(`no registry implemented for type "${key.type}"`)
    return fetcher.fetchPackage(key, ctx)
}
