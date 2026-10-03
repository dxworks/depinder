import {fromRegistryName, HttpError, registryName} from '@depinder/core'
import {highest, isPrerelease} from './latest.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './shared.js'
import type {FeedEvent, FeedResult, FetchContext, FetchedPackage, FetchedVersion, Registry} from './types.js'

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
const CHANGES_URL = 'https://packagist.org/metadata/changes.json'
const SOURCE = 'repo.packagist.org'

/** Packagist's cursor is unix seconds × 10 000. Its own `timestamp` field is in the same unit. */
const CURSOR_SCALE = 10_000

interface MetadataFile {
    /** `"composer/2.0"` when the entries are minified. Absent means they are already complete. */
    minified?: unknown
    packages?: Record<string, unknown[]>
}

interface ChangesResponse {
    actions?: {type?: unknown; package?: unknown; time?: unknown}[]
    timestamp?: unknown
    error?: unknown
}

export const composerRegistry: Registry = {
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

    feed: {
        mode: 'feed',
        intervalMs: 60_000,

        /**
         * Packagist will not hand out its clock on its own, so the head is read by asking for a
         * minute of changes and keeping the `timestamp` it answers with. A `since` it considers
         * invalid still comes back with that timestamp, which is the whole point of the error.
         */
        async initialCursor(ctx: FetchContext): Promise<string> {
            const since = (Math.floor(Date.now() / 1000) - 60) * CURSOR_SCALE
            const response = await ctx.http.get(`${CHANGES_URL}?since=${since}`)
            const body = response.text ? response.json<ChangesResponse>() : {}
            const timestamp = numberOrUndefined(body.timestamp)
            if (timestamp !== undefined) return String(timestamp)
            if (!response.ok) {
                throw new HttpError(
                    `packagist.org returned ${response.status} for the changes head`,
                    response.url,
                    response.status,
                )
            }
            return String(Math.floor(Date.now() / 1000) * CURSOR_SCALE)
        },

        async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
            const response = await ctx.http.get(`${CHANGES_URL}?since=${encodeURIComponent(cursor)}`)
            const body = response.text ? response.json<ChangesResponse>() : {}
            const timestamp = numberOrUndefined(body.timestamp)

            if (!response.ok) {
                // A cursor older than the window Packagist keeps is answered with a 400 carrying
                // the current timestamp. Failing forever on that would freeze the feed, so we jump
                // to the head and say so: the gap is repaired by the next full re-fetch of each
                // package, not by crawling a million names.
                if (timestamp !== undefined) {
                    ctx.log.warn('packagist rejected the feed cursor, restarting from its head', {
                        cursor,
                        status: response.status,
                        head: timestamp,
                    })
                    return {events: [], cursor: String(timestamp), cursorTime: null, headTime: headTimeOf(timestamp)}
                }
                throw new HttpError(
                    `packagist.org returned ${response.status} for changes.json`,
                    response.url,
                    response.status,
                )
            }

            const actions = Array.isArray(body.actions) ? body.actions : []
            const newCursor = timestamp === undefined ? cursor : String(timestamp)
            const headTime = timestamp === undefined ? null : headTimeOf(timestamp)

            if (actions.some(action => action.type === 'resync')) {
                // `resync` means "your view is stale, read everything again". Crawling all of
                // Packagist is never the right answer to that; the packages we track are re-read
                // on their own schedule anyway.
                ctx.log.warn('packagist asked for a full resync; skipping this batch', {cursor})
                return {events: [], cursor: newCursor, cursorTime: null, headTime}
            }

            let maxTime: number | null = null
            const latestPerPackage = new Map<string, Date | null>()

            for (const action of actions) {
                const type = stringOrUndefined(action.type)
                if (type !== 'update' && type !== 'delete') continue
                const at = toDate(numberOrUndefined(action.time))
                if (at && (maxTime === null || at.getTime() > maxTime)) maxTime = at.getTime()

                const name = stringOrUndefined(action.package)
                if (!name) continue
                // `vendor/name~dev` and `vendor/name` are two metadata files for one package.
                const packageKey = eventPackageKey(name.replace(/~dev$/, ''))
                if (!packageKey) continue
                const previous = latestPerPackage.get(packageKey)
                if (previous === undefined || (at && (previous === null || at > previous))) {
                    latestPerPackage.set(packageKey, at)
                }
            }

            const events: FeedEvent[] = [...latestPerPackage].map(([packageKey, at]) => ({packageKey, at}))
            return {
                events,
                cursor: newCursor,
                cursorTime: maxTime === null ? null : new Date(maxTime),
                headTime,
            }
        },
    },
}

/** The cursor unit is unix seconds × 10 000, so dividing it back gives Packagist's own head time. */
function headTimeOf(timestamp: number): Date | null {
    return toDate(Math.floor(timestamp / CURSOR_SCALE))
}

function eventPackageKey(name: string): string | null {
    if (!name.includes('/')) return null
    try {
        return fromRegistryName('composer', name).packageKey
    } catch {
        return null
    }
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

function numberOrUndefined(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return undefined
}
