import {Vulnerability} from './vulnerability-checker'

/** What depinder knows about one library, as the local cache stores it and the reports read it. */

interface LibraryVersion {
    version: string
    timestamp: number
    licenses?: string | string[]
    downloads?: number
    latest: boolean
    /**
     * The registry withdrew this version (a yanked crate, an unlisted NuGet package). It stays
     * listed because a project can still pin it; it is never `latest` and never an upgrade target.
     */
    yanked?: boolean
}

/** The versions a project could move to: every version the registry has not withdrawn. */
export function availableVersions<T extends {yanked?: boolean}>(versions: T[]): T[] {
    return versions.filter(it => !it.yanked)
}

export interface LibraryInfo {
    name: string
    description?: string
    versions: LibraryVersion[]
    licenses: string[]
    keywords?: string[]
    issuesUrl?: string[]
    reposUrl?: string[]
    homepageUrl?: string
    documentationUrl?: string
    packageUrl?: string
    downloads?: number
    authors?: string[],
    vulnerabilities?: Vulnerability[]
    requiresLicenseAcceptance?: boolean
}
