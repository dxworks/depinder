import {HttpError} from './http.js'
import {highest, isPrerelease} from './latest.js'
import {errorMessage, fromRegistryName, registryName} from '@depinder/core'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './shared.js'
import type {FeedEvent, FeedResult, FetchContext, FetchedPackage, FetchedVersion, Registry} from './types.js'

/**
 * nuget.
 *
 * Facts come from the gzipped semver2 registration blobs
 * (`api.nuget.org/v3/registration5-gz-semver2/<id-lower>/index.json`). The index holds one entry
 * per version range; small packages have every entry inlined and cost one request, large ones
 * ("serilog", "system.text.json") inline nothing and need one request per page. That fan-out is
 * bounded here as well as by the limiter, because an id with a hundred pages must not be able to
 * spend the whole ecosystem's budget on itself.
 *
 * The body is served `content-encoding: gzip` whether or not we ask for it; undici decodes it
 * before we see the text, which is why nothing here touches zlib.
 *
 * Two quirks of the data:
 *
 *  - An **unlisted** package keeps its registration entry with `listed: false` and a `published`
 *    of `1900-01-01`, a sentinel rather than a date. Unlisted is nuget's yank, so those versions
 *    are `yanked: true`. Their real date is the catalog leaf's `created` — the leaf the entry's
 *    `@id` points at — so each unlisted version costs one more request (see
 *    `fillUnlistedDates`). Projects pin unlisted versions all the time; without the date their
 *    age would be unknown.
 *  - There is **no "latest" designation** anywhere in this API — nuget.org computes it in its
 *    search service, which is not the registry of record. So `registryLatest` is left undefined
 *    and `computeLatest` takes the highest stable version, which is what that search answers.
 */

const REGISTRATION_URL = 'https://api.nuget.org/v3/registration5-gz-semver2'
const CATALOG_INDEX_URL = 'https://api.nuget.org/v3/catalog0/index.json'
const SOURCE = 'api.nuget.org'

/** Registration pages and catalog pages fetched at once. The limiter caps the total anyway. */
const PAGE_CONCURRENCY = 4

/** Catalog pages consumed in one poll. A backlog drains over the following ticks. */
const MAX_FEED_PAGES = 20

/** `1900-01-01` is nuget's "never published" sentinel; no real package predates 1980 either. */
const EARLIEST_REAL_YEAR = 1980

/**
 * Catalog leaves read for unlisted versions in one fetch, highest versions first. Measured on
 * 2026-10-02: `system.text.json` has 42 unlisted versions, `newtonsoft.json` 31, a fully unlisted
 * `blazored.localstorage` 41; the cap only bounds a pathological package.
 */
const MAX_UNLISTED_LEAVES = 100

interface CatalogEntry {
    /** The catalog leaf's URL. */
    '@id'?: unknown
    version?: unknown
    published?: unknown
    listed?: unknown
    licenseExpression?: unknown
    licenseUrl?: unknown
    description?: unknown
    projectUrl?: unknown
    repository?: unknown
}

interface RegistrationLeaf {
    catalogEntry?: CatalogEntry
}

interface RegistrationPage {
    '@id'?: unknown
    items?: RegistrationLeaf[]
}

interface RegistrationIndex {
    items?: RegistrationPage[]
}

interface CatalogIndexPage {
    '@id'?: unknown
    commitTimeStamp?: unknown
}

interface CatalogIndex {
    commitTimeStamp?: unknown
    items?: CatalogIndexPage[]
}

interface CatalogItem {
    commitTimeStamp?: unknown
    'nuget:id'?: unknown
}

interface CatalogPage {
    items?: CatalogItem[]
}

export const nugetRegistry: Registry = {
    type: 'nuget',

    async fetchPackage(key, ctx) {
        // `purl.ts` already lowercases nuget ids; the blob paths only exist in lowercase.
        const id = registryName(key).toLowerCase()
        const response = await ctx.http.get(`${REGISTRATION_URL}/${encodeURIComponent(id)}/index.json`)
        if (response.status === 404) return null
        if (!response.ok) {
            throw new HttpError(`${SOURCE} returned ${response.status} for ${id}`, response.url, response.status)
        }

        const index = response.json<RegistrationIndex>()
        const pages = index.items ?? []
        const perPage = await mapWithConcurrency(pages, PAGE_CONCURRENCY, async page => {
            if (Array.isArray(page.items)) return page.items
            const url = stringOrUndefined(page['@id'])
            if (!url) return []
            const pageResponse = await ctx.http.get(url)
            if (!pageResponse.ok) {
                throw new HttpError(
                    `${SOURCE} returned ${pageResponse.status} for a registration page of ${id}`,
                    pageResponse.url,
                    pageResponse.status,
                )
            }
            return pageResponse.json<RegistrationPage>().items ?? []
        })

        const fetched = packageFromLeaves(perPage.flat())
        await fillUnlistedDates(fetched, perPage.flat(), ctx)
        return fetched
    },

    feed: {
        mode: 'feed',
        intervalMs: 60_000,

        /** The catalog's head commit. Everything committed before it is already in our packages. */
        async initialCursor(ctx: FetchContext): Promise<string> {
            const index = await readCatalogIndex(ctx)
            const head = stringOrUndefined(index.commitTimeStamp)
            if (!head) throw new Error(`${SOURCE} catalog index has no commitTimeStamp`)
            return head
        },

        async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
            const index = await readCatalogIndex(ctx)
            const headTime = toDate(index.commitTimeStamp)

            // Catalog timestamps are UTC ISO-8601 with a fixed number of fractional digits, so a
            // string comparison orders them exactly as the instants do.
            const due = (index.items ?? [])
                .filter(page => {
                    const at = stringOrUndefined(page.commitTimeStamp)
                    return at !== undefined && at > cursor
                })
                .sort((a, b) => String(a.commitTimeStamp).localeCompare(String(b.commitTimeStamp)))
                .slice(0, MAX_FEED_PAGES)

            const pages = await mapWithConcurrency(due, PAGE_CONCURRENCY, async page => {
                const url = stringOrUndefined(page['@id'])
                if (!url) return {items: []} as CatalogPage
                const response = await ctx.http.get(url)
                if (!response.ok) {
                    throw new HttpError(
                        `${SOURCE} returned ${response.status} for a catalog page`,
                        response.url,
                        response.status,
                    )
                }
                return response.json<CatalogPage>()
            })

            let newCursor = cursor
            const latestPerPackage = new Map<string, Date | null>()

            for (const page of pages) {
                for (const item of page.items ?? []) {
                    const at = stringOrUndefined(item.commitTimeStamp)
                    if (at === undefined || at <= cursor) continue
                    if (at > newCursor) newCursor = at
                    const id = stringOrUndefined(item['nuget:id'])
                    if (!id) continue
                    const packageKey = eventPackageKey(id)
                    if (!packageKey) continue
                    const date = toDate(at)
                    const previous = latestPerPackage.get(packageKey)
                    if (previous === undefined || (date && (previous === null || date > previous))) {
                        latestPerPackage.set(packageKey, date)
                    }
                }
            }

            const events: FeedEvent[] = [...latestPerPackage].map(([packageKey, at]) => ({packageKey, at}))
            return {
                events,
                cursor: newCursor,
                cursorTime: newCursor === cursor ? null : toDate(newCursor),
                headTime,
            }
        },
    },
}

async function readCatalogIndex(ctx: FetchContext): Promise<CatalogIndex> {
    const response = await ctx.http.get(CATALOG_INDEX_URL)
    if (!response.ok) {
        throw new HttpError(
            `${SOURCE} returned ${response.status} for the catalog index`,
            response.url,
            response.status,
        )
    }
    return response.json<CatalogIndex>()
}

function eventPackageKey(id: string): string | null {
    try {
        return fromRegistryName('nuget', id).packageKey
    } catch {
        return null
    }
}

/**
 * The release date of each unlisted version, from its catalog leaf's `created`. A leaf that will
 * not load leaves its version undated rather than failing the package: the date is the only
 * thing it would have added.
 */
async function fillUnlistedDates(
    fetched: FetchedPackage,
    leaves: RegistrationLeaf[],
    ctx: FetchContext,
): Promise<void> {
    const leafUrls = new Map<string, string>()
    for (const leaf of leaves) {
        const version = stringOrUndefined(leaf.catalogEntry?.version)
        const url = stringOrUndefined(leaf.catalogEntry?.['@id'])
        if (version && url) leafUrls.set(version, url)
    }

    const undated = fetched.versions
        .filter(v => v.yanked && v.releasedAt === null && leafUrls.has(v.version))
        .reverse() // version-ascending, so the highest come first
        .slice(0, MAX_UNLISTED_LEAVES)

    await mapWithConcurrency(undated, PAGE_CONCURRENCY, async version => {
        const url = leafUrls.get(version.version)!
        try {
            const response = await ctx.http.get(url)
            if (!response.ok) {
                ctx.log.debug('catalog leaf unavailable', {version: version.version, url, status: response.status})
                return
            }
            version.releasedAt = realDate(response.json<{created?: unknown}>().created)
        } catch (e) {
            ctx.log.debug('catalog leaf failed', {version: version.version, url, error: errorMessage(e)})
        }
    })
}

/** A date, unless it is missing or nuget's `1900-01-01` sentinel. */
function realDate(value: unknown): Date | null {
    const date = toDate(value)
    return date && date.getUTCFullYear() >= EARLIEST_REAL_YEAR ? date : null
}

// --- mapping ---------------------------------------------------------------------------------

/** Exported for the tests: the pure registration-leaves -> FetchedPackage mapping. */
export function packageFromLeaves(leaves: RegistrationLeaf[]): FetchedPackage {
    const entries = leaves.map(leaf => leaf.catalogEntry).filter((e): e is CatalogEntry => e != null)

    const versions: FetchedVersion[] = []
    for (const entry of entries) {
        const version = stringOrUndefined(entry.version)
        if (!version) continue
        versions.push({
            version,
            // Unlisted versions carry the sentinel; `fillUnlistedDates` dates them afterwards.
            releasedAt: realDate(entry.published),
            licenses: entryLicenses(entry),
            prerelease: isPrerelease('nuget', version),
            yanked: entry.listed === false,
        })
    }

    // Metadata belongs to the newest version anyone can still install, which is the last listed
    // entry: registration pages and their leaves are both ordered by version, ascending.
    const listed = entries.filter(entry => entry.listed !== false)
    const newest = listed.at(-1) ?? entries.at(-1)
    // Not every version declares a project URL — xunit.assert's newest ones dropped it — so the
    // homepage is the newest one that does, listed versions first.
    const homepage = [...entries.filter(entry => entry.listed === false), ...listed]
        .reverse()
        .map(entry => stringOrUndefined(entry.projectUrl))
        .find(url => url !== undefined)

    return {
        description: stringOrUndefined(newest?.description),
        homepageUrl: homepage,
        // Only the catalog leaves carry `repository`; registration blobs usually drop it, so this
        // is undefined far more often than not.
        repoUrl: normaliseRepoUrl(newest?.repository),
        licenses: packageLicenses(versions),
        versions,
        // No "latest" in this API — see the file header.
        sources: [SOURCE],
    }
}

/**
 * `licenseExpression` is the modern field and an SPDX expression, so it is kept whole. Packages
 * published before it existed only have `licenseUrl`, and a URL is a worse answer than an SPDX id
 * but a much better one than nothing.
 */
function entryLicenses(entry: CatalogEntry): string[] {
    const expression = stringOrUndefined(entry.licenseExpression)
    if (expression) return normaliseLicenses(expression)
    const url = stringOrUndefined(entry.licenseUrl)
    return url ? [url] : []
}

/**
 * The library-level answer is the version a consumer would actually get: the highest stable one,
 * as `computeLatest` picks it — not the newest publish, which is often a servicing release of an
 * older major.
 */
function packageLicenses(versions: FetchedVersion[]): string[] {
    const usable = versions.filter(v => !v.yanked && v.licenses.length > 0)
    const stable = usable.filter(v => !v.prerelease)
    return highest(stable.length > 0 ? stable : usable)?.licenses ?? []
}

/** `Promise.all` with a ceiling on how many are in flight, preserving input order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
        for (;;) {
            const index = next++
            if (index >= items.length) return
            results[index] = await fn(items[index]!)
        }
    })
    await Promise.all(workers)
    return results
}
