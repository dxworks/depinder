import {LibraryInfo} from '../extension-points/registrar'
import {log} from '../utils/logging'
import {fetchLibraryInfo, FallbackPackage, FallbackResult} from './fetch-library-info'
import {librariesIoFallback, LibrariesIoFallback} from './libraries-io'
import {createRegistryClients} from './registry-clients'
import {packagesAtOnce, RegistryLimits} from './registry-limits'

/**
 * How `analyse` looks up a package the resolver did not answer: core's fetch (the same road the
 * server takes), then Libraries.io where D8 allows it. A failed lookup throws, as the registrars did.
 */

export interface RegistryFallback {
    lookup(pkg: FallbackPackage): Promise<LibraryInfo>
    /** Dependencies of this purl type looked up at once. */
    packagesAtOnce(type: string): number
}

export interface RegistryFallbackDeps {
    fetchInfo: (pkg: FallbackPackage) => Promise<FallbackResult>
    librariesIo: LibrariesIoFallback
    /** Waits between attempts after a 429 that core's own single retry did not get past. */
    rateLimitDelaysMs?: readonly number[]
}

const RATE_LIMIT_RETRY_DELAYS_MS = [2000, 4000, 8000]

export function isRateLimit(e: any): boolean {
    return e?.response?.status === 429 || e?.status === 429
}

/** The fallback over the real registries, with the CLI's limits. */
export function createRegistryFallback(limits: RegistryLimits): RegistryFallback {
    const clients = createRegistryClients({limits: limits.limits})
    return {
        ...registryFallbackWith({fetchInfo: pkg => fetchLibraryInfo(pkg, {clients}), librariesIo: librariesIoFallback()}),
        packagesAtOnce: type => packagesAtOnce(limits, type),
    }
}

/** The lookup alone, over whatever fetch and Libraries.io it is given. */
export function registryFallbackWith(deps: RegistryFallbackDeps): Pick<RegistryFallback, 'lookup'> {
    const delays = deps.rateLimitDelaysMs ?? RATE_LIMIT_RETRY_DELAYS_MS
    return {
        async lookup(pkg) {
            for (let attempt = 0; ; attempt++) {
                try {
                    return await lookupOnce(pkg, deps)
                } catch (e: any) {
                    if (!isRateLimit(e) || attempt >= delays.length) throw e
                    log.warn(`Rate limited (429) retrieving ${pkg.name}, retrying in ${delays[attempt]}ms`)
                    await new Promise(resolve => setTimeout(resolve, delays[attempt]))
                }
            }
        },
    }
}

async function lookupOnce(pkg: FallbackPackage, deps: RegistryFallbackDeps): Promise<LibraryInfo> {
    const result = await deps.fetchInfo(pkg)
    if (result.status === 'found') return result.info
    if (deps.librariesIo.covers(pkg.type)) return deps.librariesIo.retrieve(pkg.type, pkg.name)
    if (result.status === 'not_found') throw new Error(`${pkg.name} is not in the ${pkg.type} registry`)
    throw result.error
}
