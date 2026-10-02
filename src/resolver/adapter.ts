import {LibraryInfo} from '../extension-points/registrar'
import {PackageRecord, VERSION_FLAG_YANKED} from './client'

/**
 * A resolver `PackageRecord` in the shape the rest of depinder already speaks, `LibraryInfo`.
 *
 * The cache, the CSV writers and `update` all read `LibraryInfo`, so a record that goes through
 * here is indistinguishable downstream from one a registrar produced — which is what lets phase 3
 * of `analyse` stay exactly as it was.
 */

/**
 * The name a package is known by in its registry, and therefore the name depinder's parsers
 * produced and the cache is keyed on: `group:artifact` for maven, `@scope/name` for npm,
 * `vendor/package` for composer, the full module path for golang, the bare name for the rest.
 */
export function registryNameOf(pkg: PackageRecord): string {
    const namespace = pkg.namespace?.trim()
    if (!namespace) return pkg.name
    if (pkg.type === 'maven') return `${namespace}:${pkg.name}`
    // An npm namespace is a scope and always carries its `@`; a server that dropped it would
    // otherwise produce a name no parser ever emits, and so a cache entry nothing reads.
    if (pkg.type === 'npm' && !namespace.startsWith('@')) return `@${namespace}/${pkg.name}`
    return `${namespace}/${pkg.name}`
}

/**
 * Epoch milliseconds, `NaN` when the registry has no date for a version — the same thing the Go
 * and Rust registrars produce (`Date.parse(...Time ?? '')`), so the CSV columns treat a dateless
 * version identically whichever source filled it. The wire carries epoch seconds, so the only
 * difference from the old ISO-string shape is that a timestamp is now second-precise.
 */
function timestampOf(releasedAt: number | null): number {
    return releasedAt === null ? NaN : releasedAt * 1000
}

/**
 * `homepageUrl` is what the Black Duck export writes as `Component Link`, so it carries the URL
 * each registrar put there before the resolver existed, chosen from the two the server sends.
 * Composer and cargo prefer the repository: Black Duck holds the source repository for them
 * (packagist `source.url` matched 40% against 4% for `homepage`; a crate's `homepage` is usually
 * its docs site). Every other ecosystem prefers the declared homepage and falls back to the
 * repository, as the npm registrar does with `homepage` and `repository`.
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
        name: registryNameOf(pkg),
        description: pkg.description ?? '',
        // A yanked version is one the registry itself says not to use, so it is not a version
        // anyone could upgrade to. Same exclusion the crates.io registrar already makes.
        versions: (pkg.versions ?? [])
            .filter(([, , flags]) => (flags & VERSION_FLAG_YANKED) === 0)
            .map(([version, releasedAt, , licenses]) => ({
                version,
                timestamp: timestampOf(releasedAt),
                latest: !!pkg.latest && version === pkg.latest.version,
                licenses: licenses ?? packageLicenses,
            })),
        licenses: packageLicenses,
        homepageUrl: componentLinkOf(pkg),
        reposUrl: pkg.repo_url ? [pkg.repo_url] : [],
        // The resolver serves registry facts only; advisories stay with the GitHub lookup in
        // `analyse`, which is why this is empty rather than absent.
        issuesUrl: [],
        keywords: [],
    }
}
