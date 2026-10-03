import {canFetch, fetchPackage, fromRegistryName, nullLogger, toPackageRecord, type Logger} from '@depinder/core'
import {LibraryInfo} from '../extension-points/registrar'
import {toLibraryInfo} from '../resolver/adapter'
import {RegistryClients} from './registry-clients'

/**
 * The CLI's own road to a package's facts when the resolver gave none: core's fetch, core's
 * conversion to the wire record, then the same adapter that reads the resolver's answers. Taking
 * the server's steps in the server's order is what keeps both roads giving the same `LibraryInfo`.
 */

/** A package as `analyse` knows it: its purl type and the name its registry uses. */
export interface FallbackPackage {
    /** purl type, e.g. `maven`, `npm`, `pypi`. */
    type: string
    /** `group:artifact` for maven, `@scope/name` for npm, `vendor/package` for composer, the module path for golang. */
    name: string
}

/**
 * `not_found` is the registry saying it has no such package; `error` is everything else that gave
 * no answer. Both are handed on to Libraries.io where it applies (D8), so they stay apart here.
 */
export type FallbackResult =
    | {status: 'found', info: LibraryInfo}
    | {status: 'not_found'}
    | {status: 'error', error: unknown}

export interface FallbackDeps {
    clients: RegistryClients
    log?: Logger
    /** When the fetch started; the record's `fetched_at` and `confirmed_at`. */
    now?: () => Date
}

/** Never throws: a bad name, an unsupported type or a failed fetch comes back as `error`. */
export async function fetchLibraryInfo(pkg: FallbackPackage, deps: FallbackDeps): Promise<FallbackResult> {
    try {
        if (!canFetch(pkg.type)) throw new Error(`no registry implemented for type "${pkg.type}"`)
        const key = fromRegistryName(pkg.type, pkg.name)
        const fetchedAt = deps.now?.() ?? new Date()
        const resolved = await fetchPackage(key, {http: deps.clients.forType(pkg.type), log: deps.log ?? nullLogger})
        if (!resolved) return {status: 'not_found'}
        return {status: 'found', info: toLibraryInfo(toPackageRecord(key, resolved, fetchedAt))}
    } catch (error) {
        return {status: 'error', error}
    }
}
