import type {HttpClient} from '../http/client.js'
import type {Logger} from '../log.js'
import type {ParsedPurl} from '../purl.js'

/**
 * The contract every ecosystem's fetcher implements. One file (or folder) per purl type in this
 * folder, registered in `index.ts`. See the server's `docs/adding-a-registry.md`.
 */

export interface FetchedVersion {
    /** Exactly as the registry spells it. Not normalised, not stripped of a leading `v`. */
    version: string
    releasedAt: Date | null
    /** SPDX-ish strings, already normalised by the registry file. `[]` when unknown. */
    licenses: string[]
    prerelease: boolean
    /** Yanked (cargo), unlisted (nuget), withdrawn (pypi). Excluded from `latest`. */
    yanked: boolean
}

export interface FetchedPackage {
    description?: string
    homepageUrl?: string
    repoUrl?: string
    /** Library-level licenses. `[]` when the registry publishes none. */
    licenses: string[]
    versions: FetchedVersion[]
    /** The registry's own "latest" designation, if it has one. */
    registryLatest?: string
    /** Hosts the facts came from, e.g. `['registry.npmjs.org']`. Stored as provenance. */
    sources: string[]
    /**
     * Set when these facts are known to be incomplete for now, and when to fetch the package
     * again. golang uses it for a new version deps.dev has not scanned yet. Absent means the facts
     * are as complete as the registry can make them.
     */
    recheckAt?: Date
}

/** A fetched package with the latest rule applied: what every caller of `fetchPackage` gets. */
export interface ResolvedPackage extends FetchedPackage {
    /** The version depinder calls latest. See `computeLatest` in `latest.ts`. */
    latest?: string
    /** The newest version overall, only when it differs from `latest`. */
    latestPrerelease?: string
}

export interface FetchContext {
    /** Timeout, User-Agent and the caller's per-ecosystem limiter. Never call `fetch`. */
    http: HttpClient
    log: Logger
    options: RegistryOptions
}

export interface RegistryOptions {
    mavenPerVersionLicenses: boolean
}

// [10] THE CONTRACT [7] calls (its feed half is the server's `Registry`). Next [11], the server's registries/types.ts.
export interface PackageFetcher {
    /** purl type, e.g. `npm`. Must match the key in the `fetchers` map. */
    type: string
    /**
     * All facts about one package. `null` means the registry answered "no such package" (404).
     * Anything else — a 5xx, a timeout, a malformed body — must throw, so the caller can retry.
     */
    fetchPackage(key: ParsedPurl, ctx: FetchContext): Promise<FetchedPackage | null>
}
