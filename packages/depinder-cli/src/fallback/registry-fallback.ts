import {HttpError} from '@depinder/core'
import {LibraryInfo} from '../extension-points/library-info'
import {coreLogger} from '../utils/logging'
import {countRequest} from '../utils/profile'
import {fetchLibraryInfo, FallbackPackage, FallbackResult} from './fetch-library-info'
import {librariesIoFallback, LibrariesIoFallback} from './libraries-io'
import {createRegistryClients} from './registry-clients'
import {packagesAtOnce, RegistryLimits} from './registry-limits'

/**
 * How `analyse` looks up a package the resolver did not answer: core's fetch (the same road the
 * server takes), then Libraries.io where D8 allows it. A failed lookup throws, as the registrars did.
 * Rate limits are core's to handle: its client waits out a 429 once, honouring `Retry-After`.
 */

export interface RegistryFallback {
    lookup(pkg: FallbackPackage): Promise<LibraryInfo>
    /** Dependencies of this purl type looked up at once. */
    packagesAtOnce(type: string): number
}

export interface RegistryFallbackDeps {
    fetchInfo: (pkg: FallbackPackage) => Promise<FallbackResult>
    librariesIo: LibrariesIoFallback
}

/** A registry that still answered 429 after core's client waited it out once. */
export function isRateLimit(e: unknown): boolean {
    return e instanceof HttpError && e.status === 429
}

/** The fallback over the real registries, with the CLI's limits. */
export function createRegistryFallback(limits: RegistryLimits): RegistryFallback {
    const clients = createRegistryClients({limits: limits.limits, onRequest: event => countRequest(event.url)})
    const log = coreLogger()
    return {
        ...registryFallbackWith({fetchInfo: pkg => fetchLibraryInfo(pkg, {clients, log}), librariesIo: librariesIoFallback()}),
        packagesAtOnce: type => packagesAtOnce(limits, type),
    }
}

/** The lookup alone, over whatever fetch and Libraries.io it is given. */
export function registryFallbackWith(deps: RegistryFallbackDeps): Pick<RegistryFallback, 'lookup'> {
    return {
        async lookup(pkg) {
            const result = await deps.fetchInfo(pkg)
            if (result.status === 'found') return result.info
            if (deps.librariesIo.covers(pkg.type)) return deps.librariesIo.retrieve(pkg.type, pkg.name)
            if (result.status === 'not_found') throw new Error(`${pkg.name} is not in the ${pkg.type} registry`)
            throw result.error
        },
    }
}
