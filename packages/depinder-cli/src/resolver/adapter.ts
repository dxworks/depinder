import {LibraryInfo} from '../extension-points/library-info'
import {type PackageRecord, registryName, VERSION_FLAG_PRERELEASE, VERSION_FLAG_YANKED} from '@depinder/core'

/**
 * A `PackageRecord` in the shape the rest of depinder speaks, `LibraryInfo`.
 *
 * The cache, the CSV writers and `update` all read `LibraryInfo`. The resolver's answers and the
 * registry fallback's both come through here, so downstream cannot tell which source filled one.
 */

/**
 * Epoch milliseconds, `NaN` when the registry has no date for a version. The wire carries epoch
 * seconds, so a timestamp is second-precise.
 */
function timestampOf(releasedAt: number | null): number {
    return releasedAt === null ? NaN : releasedAt * 1000
}

/**
 * `homepageUrl` is what the Black Duck export writes as `Component Link`, so it carries the URL
 * depinder has always written there, chosen from the two the server sends.
 * Composer and cargo prefer the repository: Black Duck holds the source repository for them
 * (packagist `source.url` matched 40% against 4% for `homepage`; a crate's `homepage` is usually
 * its docs site). Every other ecosystem prefers the declared homepage and falls back to the
 * repository, as core's npm rule does with `homepage` and `repository`.
 */
export function componentLinkOf(pkg: Pick<PackageRecord, 'type' | 'homepage_url' | 'repo_url'>): string {
    const homepage = pkg.homepage_url?.trim() || ''
    const repo = pkg.repo_url?.trim() || ''
    return REPOSITORY_FIRST.has(pkg.type) ? repo || homepage : homepage || repo
}

const REPOSITORY_FIRST = new Set(['composer', 'cargo'])

export function toLibraryInfo(pkg: PackageRecord): LibraryInfo {
    // A three-element tuple means "this version's licenses are the package's licenses"; the
    // server only spends the bytes on a fourth element when the two differ, an explicit `[]`
    // included. Expanding here is what keeps `licenseOf` and `toComponent` seeing what they saw
    // when every version carried its own copy.
    const packageLicenses = pkg.licenses ?? []
    return {
        name: registryName(pkg),
        // A yanked version stays in the list, marked: a project can still be pinned to one (an
        // unlisted NuGet package, a yanked crate), and its row needs that version's release date
        // and licence. It is never `latest`, and the readers that count versions to upgrade to
        // leave it out (`availableVersions`).
        versions: (pkg.versions ?? []).map(([version, releasedAt, flags, licenses]) => {
            const yanked = (flags & VERSION_FLAG_YANKED) !== 0
            const prerelease = (flags & VERSION_FLAG_PRERELEASE) !== 0
            return {
                version,
                timestamp: timestampOf(releasedAt),
                latest: !yanked && !!pkg.latest && version === pkg.latest.version,
                licenses: licenses ?? packageLicenses,
                ...(yanked ? {yanked: true} : {}),
                ...(prerelease ? {prerelease: true} : {}),
            }
        }),
        licenses: packageLicenses,
        homepageUrl: componentLinkOf(pkg),
    }
}
