import {mapWithConcurrency} from '../concurrency.js'
import {HttpError} from '../http/client.js'
import {errorMessage} from '../log.js'
import {registryName} from '../purl.js'
import {highest, isPrerelease} from './latest.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './normalise.js'
import type {FetchContext, FetchedPackage, FetchedVersion, PackageFetcher} from './types.js'

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
const SOURCE = 'api.nuget.org'

/** Registration pages and catalog leaves fetched at once. The limiter caps the total anyway. */
const PAGE_CONCURRENCY = 4

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

export const nugetFetcher: PackageFetcher = {
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
 * older major. A package whose publisher unlisted every version (blazored.localstorage) still has
 * a license: the highest unlisted version's.
 */
function packageLicenses(versions: FetchedVersion[]): string[] {
    const anyListed = versions.some(v => !v.yanked)
    const candidates = anyListed ? versions.filter(v => !v.yanked) : versions
    const usable = candidates.filter(v => v.licenses.length > 0)
    const stable = usable.filter(v => !v.prerelease)
    return highest(stable.length > 0 ? stable : usable)?.licenses ?? []
}
