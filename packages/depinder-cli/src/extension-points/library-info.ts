import {pseudoVersionTime} from '@depinder/core'
import {Vulnerability} from './vulnerability-checker'

/** What depinder knows about one library, as the local cache stores it and the reports read it. */

interface LibraryVersion {
    version: string
    timestamp: number
    licenses?: string | string[]
    latest: boolean
    /**
     * The registry withdrew this version (a yanked crate, an unlisted NuGet package). It stays
     * listed because a project can still pin it; it is never `latest` and never an upgrade target.
     */
    yanked?: boolean
    /**
     * A pre-release by core's rule, the flag the resolver ships. Upgrade guidance recommends one
     * only when no stable version clears the findings.
     */
    prerelease?: boolean
}

/** The versions a project could move to: every version the registry has not withdrawn. */
export function availableVersions<T extends {yanked?: boolean}>(versions: T[]): T[] {
    return versions.filter(it => !it.yanked)
}

/**
 * When the version a project uses was released: the registry's date for it, or, for a Go
 * pseudo-version the proxy never lists, the commit time the version string carries. `undefined` or
 * `NaN` when neither is known.
 */
export function usedVersionTimestamp(versions: LibraryVersion[] | undefined, version: string): number | undefined {
    const listed = versions?.find(it => it.version === version.trim())?.timestamp
    if (listed !== undefined && Number.isFinite(listed)) return listed
    return pseudoVersionTime(version.trim())?.getTime() ?? listed
}

export interface LibraryInfo {
    name: string
    versions: LibraryVersion[]
    licenses: string[]
    homepageUrl?: string
    vulnerabilities?: Vulnerability[]
}
