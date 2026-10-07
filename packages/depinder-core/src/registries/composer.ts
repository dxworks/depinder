import {HttpError} from '../http/client.js'
import {registryName} from '../purl.js'
import {highest, isPrerelease} from './latest.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './normalise.js'
import type {FetchContext, FetchedPackage, FetchedVersion, PackageFetcher} from './types.js'

/**
 * composer.
 *
 * Facts come from Packagist's v2 metadata files — `repo.packagist.org/p2/<vendor>/<pkg>.json` for
 * tagged releases and `…~dev.json` for branches — which is what `composer update` itself reads.
 * (The website API at `packagist.org/packages/<vendor>/<pkg>.json` is a different, slower thing
 * with its own rate limit; it is not the registry of record.) A missing `~dev` file means the
 * package has no branches, not that the package is missing.
 *
 * Both files are **minified** per `composer/metadata-minifier`: each entry after the first lists
 * only the keys that changed since the previous one, and `"__unset"` means the key went away.
 * Reading such a file without expanding it gives versions with no license and no time, which is
 * exactly the shape a bug takes here — it looks like sparse data rather than a decoding mistake.
 *
 * Packagist has no "latest" designation, so `registryLatest` is left undefined and `computeLatest`
 * picks the highest stable version — not the newest by date, which for a framework that patches
 * several majors at once (`laravel/framework` v11.57.0 shipping after v13.34.0) is an old line.
 * Every `dev-*` / `*-dev` version is a branch, and `computeLatest` never picks a branch for either
 * slot, even for a package whose tags are all pre-releases.
 */

const REPO_URL = 'https://repo.packagist.org/p2'
const SOURCE = 'repo.packagist.org'

interface MetadataFile {
    /** `"composer/2.0"` when the entries are minified. Absent means they are already complete. */
    minified?: unknown
    packages?: Record<string, unknown[]>
}

export const composerFetcher: PackageFetcher = {
    type: 'composer',

    async fetchPackage(key, ctx) {
        const name = registryName(key) // `vendor/package`, lowercased by `purl.ts`
        const path = name.split('/').map(encodeURIComponent).join('/')

        const releases = await readMetadata(ctx, `${REPO_URL}/${path}.json`, name)
        if (releases === null) return null
        // A package with no branches simply has no `~dev` file.
        const branches = await readMetadata(ctx, `${REPO_URL}/${path}~dev.json`, name)

        return packageFromMetadata(name, releases, branches)
    },
}

/** `null` for a 404 — no such file. Anything else that is not usable throws. */
async function readMetadata(ctx: FetchContext, url: string, name: string): Promise<MetadataFile | null> {
    const response = await ctx.http.get(url)
    if (response.status === 404) return null
    if (!response.ok) {
        throw new HttpError(`${SOURCE} returned ${response.status} for ${name}`, response.url, response.status)
    }
    return response.json<MetadataFile>()
}

// --- mapping ---------------------------------------------------------------------------------

/**
 * Exported for the tests: the pure metadata -> FetchedPackage mapping.
 *
 * Packagist lists newest first; the versions come back oldest first, because that is the order
 * `computeLatest` breaks ties in when a version has no date. Branches follow the tagged releases.
 */
export function packageFromMetadata(
    name: string,
    releases: MetadataFile,
    branches: MetadataFile | null,
): FetchedPackage {
    const entries = [...entriesOf(releases, name).reverse(), ...entriesOf(branches, name).reverse()]

    const versions: FetchedVersion[] = []
    const byVersion = new Map<string, Record<string, unknown>>()
    for (const entry of entries) {
        const version = stringOrUndefined(entry.version)
        if (!version || byVersion.has(version)) continue
        byVersion.set(version, entry)
        versions.push({
            version,
            releasedAt: toDate(entry.time),
            licenses: normaliseLicenses(entry.license),
            prerelease: isPrerelease('composer', version),
            // Packagist deletes rather than yanks: a removed version leaves the metadata file.
            yanked: false,
        })
    }

    const newest = newestStable(versions) ?? versions.at(-1)
    const newestEntry = newest ? byVersion.get(newest.version) : undefined

    return {
        description: stringOrUndefined(newestEntry?.description),
        homepageUrl: stringOrUndefined(newestEntry?.homepage),
        repoUrl: normaliseRepoUrl(newestEntry?.source),
        licenses: newest?.licenses ?? [],
        versions,
        // No "latest" designation on Packagist — see the file header.
        sources: [SOURCE],
    }
}

function entriesOf(file: MetadataFile | null, name: string): Record<string, unknown>[] {
    if (!file) return []
    const raw = file.packages?.[name]
    if (!Array.isArray(raw)) return []
    // Only expand when the file says it is minified: applying the carry-forward to complete
    // entries would invent a license for every version that legitimately declares none.
    return typeof file.minified === 'string' ? expandMinified(raw) : raw.filter(isRecord)
}

/**
 * `composer/metadata-minifier`'s expansion: each entry inherits everything the previous expanded
 * entry had, its own keys override, and `"__unset"` deletes.
 */
export function expandMinified(entries: unknown[]): Record<string, unknown>[] {
    const expanded: Record<string, unknown>[] = []
    let previous: Record<string, unknown> = {}

    for (const raw of entries) {
        if (!isRecord(raw)) continue
        const entry: Record<string, unknown> = {...previous}
        for (const [key, value] of Object.entries(raw)) {
            if (value === '__unset') delete entry[key]
            else entry[key] = value
        }
        expanded.push(entry)
        previous = entry
    }

    return expanded
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The highest release that is not a branch or a pre-release — the version `computeLatest` picks. */
function newestStable(versions: FetchedVersion[]): FetchedVersion | undefined {
    return highest(versions.filter(v => !v.prerelease))
}
