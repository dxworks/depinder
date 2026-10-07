import {versionPurl, type ParsedPurl} from '../purl.js'
import type {FetchedVersion, ResolvedPackage} from '../registries/types.js'

/**
 * One package as `POST /resolve` sends it and the CLI's adapter reads it: the wire contract both
 * sides implement, defined here once.
 */

/** `flags` bit 0: the version is a prerelease. */
export const VERSION_FLAG_PRERELEASE = 1
/** `flags` bit 1: the registry withdrew the version (yanked, unlisted). */
export const VERSION_FLAG_YANKED = 2

/**
 * A version as it travels — a tuple, not an object:
 *
 *     [version, released_at, flags]
 *     [version, released_at, flags, licenses]
 *
 * `released_at` is Unix epoch **seconds** (integer, floored), or `null` when the registry publishes
 * no date. `flags` is the bit set above. The fourth element is present only when this version's
 * license list differs from the package-level one; a three-element tuple means "the same as
 * `licenses`", an explicit `[]` means "this version has none although the package does".
 *
 * The shape exists because the version array is 95% of a response: field names, ISO strings and
 * two booleans were three quarters of those bytes. Never a subset — every version the registry has
 * is sent, oldest first.
 */
export type CompactVersion =
    | [version: string, releasedAt: number | null, flags: number]
    | [version: string, releasedAt: number | null, flags: number, licenses: string[]]

/** A version a package points at (its latest), with that version's release date. */
export interface VersionPointer {
    version: string
    released_at: string | null
}

export interface PackageRecord {
    type: string
    namespace: string | null
    name: string
    description: string | null
    homepage_url: string | null
    repo_url: string | null
    licenses: string[]
    latest: VersionPointer | null
    latest_prerelease: VersionPointer | null
    /** Every version the registry has, ordered by release date (undated first), then version. */
    versions: CompactVersion[]
    /** The latest instant the registry itself vouched for these facts (a fetch, or a 304 since). */
    as_of: string | null
    source: string | null
    fetched_at: string | null
    /** The latest instant these facts are known to match the registry; `max_age` is measured from it. */
    confirmed_at: string | null
}

/** `version` with the release date `versions` gives it, or null when there is no version. */
export function versionPointer(
    version: string | null | undefined,
    versions: readonly CompactVersion[],
): VersionPointer | null {
    if (!version) return null
    const seconds = versions.find(v => v[0] === version)?.[1] ?? null
    return {version, released_at: seconds === null ? null : new Date(seconds * 1000).toISOString()}
}

/**
 * A package fetched just now, as the wire carries it: what the server would send for it straight
 * after storing this fetch. `fetchedAt` is when the fetch started; nothing but the fetch vouches
 * for the facts yet, so it is also `as_of` and `confirmed_at`.
 */
export function toPackageRecord(
    key: Pick<ParsedPurl, 'type' | 'namespace' | 'name' | 'packageKey'>,
    pkg: ResolvedPackage,
    fetchedAt: Date,
): PackageRecord {
    const versions = compactVersions(key.packageKey, pkg.versions, pkg.licenses)
    const at = fetchedAt.toISOString()
    return {
        type: key.type,
        namespace: key.namespace,
        name: key.name,
        description: pkg.description ?? null,
        homepage_url: pkg.homepageUrl ?? null,
        repo_url: pkg.repoUrl ?? null,
        licenses: pkg.licenses,
        latest: versionPointer(pkg.latest, versions),
        latest_prerelease: versionPointer(pkg.latestPrerelease, versions),
        versions,
        as_of: at,
        source: pkg.sources.join(', '),
        fetched_at: at,
        confirmed_at: at,
    }
}

/** A version with the purl it is stored and served under. */
export interface DistinctVersion extends FetchedVersion {
    purl: string
}

/**
 * One version per distinct version purl, in the registry's order: a registry can list the same
 * version twice, and the first listing wins. The server stores these rows; the wire sends them.
 */
export function distinctVersions(packageKey: string, versions: readonly FetchedVersion[]): DistinctVersion[] {
    const rows: DistinctVersion[] = []
    const seen = new Set<string>()
    for (const version of versions) {
        const purl = versionPurl(packageKey, version.version)
        if (seen.has(purl)) continue
        seen.add(purl)
        rows.push({...version, purl})
    }
    return rows
}

/**
 * The versions as tuples, one per {@link distinctVersions}: undated first, then by release date,
 * then by version in code-point order (the server's read sorts with `collate "C"` to match).
 */
export function compactVersions(
    packageKey: string,
    versions: readonly FetchedVersion[],
    packageLicenses: readonly string[],
): CompactVersion[] {
    return distinctVersions(packageKey, versions)
        .sort(byReleaseThenVersion)
        .map(v => compactVersion(v, packageLicenses))
}

function compactVersion(v: FetchedVersion, packageLicenses: readonly string[]): CompactVersion {
    const releasedAt = v.releasedAt ? Math.floor(v.releasedAt.getTime() / 1000) : null
    const flags = (v.prerelease ? VERSION_FLAG_PRERELEASE : 0) | (v.yanked ? VERSION_FLAG_YANKED : 0)
    return sameLicenses(v.licenses, packageLicenses)
        ? [v.version, releasedAt, flags]
        : [v.version, releasedAt, flags, v.licenses]
}

function byReleaseThenVersion(a: FetchedVersion, b: FetchedVersion): number {
    const left = a.releasedAt?.getTime() ?? null
    const right = b.releasedAt?.getTime() ?? null
    if (left !== right) {
        if (left === null) return -1
        if (right === null) return 1
        return left - right
    }
    return a.version < b.version ? -1 : a.version > b.version ? 1 : 0
}

function sameLicenses(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((license, i) => license === b[i])
}
