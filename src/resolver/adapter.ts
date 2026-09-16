import {LibraryInfo} from '../extension-points/registrar'
import {PackageRecord} from './client'

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
 * version identically whichever source filled it.
 */
function timestampOf(releasedAt: string | null | undefined): number {
    return Date.parse(releasedAt ?? '')
}

export function toLibraryInfo(pkg: PackageRecord): LibraryInfo {
    return {
        name: registryNameOf(pkg),
        description: pkg.description ?? '',
        // A yanked version is one the registry itself says not to use, so it is not a version
        // anyone could upgrade to. Same exclusion the crates.io registrar already makes.
        versions: (pkg.versions ?? []).filter(it => !it.yanked).map(it => ({
            version: it.version,
            timestamp: timestampOf(it.released_at),
            latest: !!pkg.latest && it.version === pkg.latest.version,
            licenses: it.licenses ?? [],
        })),
        licenses: pkg.licenses ?? [],
        homepageUrl: pkg.homepage_url ?? '',
        reposUrl: pkg.repo_url ? [pkg.repo_url] : [],
        // The resolver serves registry facts only; advisories stay with the GitHub lookup in
        // `analyse`, which is why this is empty rather than absent.
        issuesUrl: [],
        keywords: [],
    }
}
