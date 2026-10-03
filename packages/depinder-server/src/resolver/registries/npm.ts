import {HttpError} from './http.js'
import {isPrerelease} from './latest.js'
import {fromRegistryName, registryName} from '@depinder/core'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './shared.js'
import type {FeedEvent, FeedResult, FetchContext, FetchedPackage, FetchedVersion, Registry} from './types.js'

/**
 * npm — the reference implementation of `Registry`.
 *
 * Facts come from the full packument (`GET https://registry.npmjs.org/<name>`), which carries
 * every version, every publish time and every per-version license in one response, so a package
 * costs exactly one request.
 *
 * Freshness comes from the CouchDB change feed on replicate.npmjs.com. Its cursor is an opaque
 * sequence number and, unlike every other feed we consume, its entries carry no timestamps. So
 * `cursorTime` is the wall-clock time of the last successful read: for npm, the lag on `/feeds`
 * answers "how long since we looked", not "how far behind the head are we". Since the loop starts
 * at the current head and reads every 30 s, the two are the same number in practice — they only
 * diverge while draining a backlog after downtime, where the reported lag is optimistic.
 */

const REGISTRY_URL = 'https://registry.npmjs.org'
const REPLICATE_URL = 'https://replicate.npmjs.com'
const SOURCE = 'registry.npmjs.org'
const CHANGES_LIMIT = 1000

interface PackumentVersion {
    license?: unknown
    licenses?: unknown
    deprecated?: string
}

interface Packument {
    name?: string
    description?: unknown
    homepage?: unknown
    repository?: unknown
    license?: unknown
    licenses?: unknown
    time?: Record<string, string>
    versions?: Record<string, PackumentVersion>
    'dist-tags'?: Record<string, string>
}

interface ChangesResponse {
    results?: {seq?: number | string; id?: string; deleted?: boolean}[]
    last_seq?: number | string
}

// [12] npm implements [10]. Read it here, then maven/index.ts:34 for the same contract in poll mode.
export const npmRegistry: Registry = {
    type: 'npm',

    // [13] The fetchPackage half of [10]: one GET of the packument = every version, date and license.
    async fetchPackage(key, ctx) {
        const name = registryName(key)
        const response = await ctx.http.get(`${REGISTRY_URL}/${encodePackageName(name)}`)
        if (response.status === 404) return null
        if (!response.ok) {
            throw new HttpError(`${SOURCE} returned ${response.status} for ${name}`, response.url, response.status)
        }
        return packageFromPackument(response.json<Packument>())
    },

    // [14] The feed half of [11]: a _changes cursor every 30s; whatever changed is re-queued at priority 20 — back to [6].
    feed: {
        mode: 'feed',
        intervalMs: 30_000,

        /**
         * The head sequence. `since=now` is rejected by replicate.npmjs.com, so the head is read
         * as the first row of a descending listing.
         */
        async initialCursor(ctx: FetchContext): Promise<string> {
            const response = await ctx.http.get(`${REPLICATE_URL}/_changes?since=0&limit=1&descending=true`)
            if (!response.ok) {
                throw new HttpError(
                    `replicate.npmjs.com returned ${response.status} for the head sequence`,
                    response.url,
                    response.status,
                )
            }
            const body = response.json<ChangesResponse>()
            if (body.last_seq == null) throw new Error('replicate.npmjs.com returned no last_seq')
            return String(body.last_seq)
        },

        async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
            const url = `${REPLICATE_URL}/_changes?since=${encodeURIComponent(cursor)}&limit=${CHANGES_LIMIT}`
            const response = await ctx.http.get(url)
            if (!response.ok) {
                throw new HttpError(
                    `replicate.npmjs.com returned ${response.status} for _changes`,
                    response.url,
                    response.status,
                )
            }
            const body = response.json<ChangesResponse>()
            const events: FeedEvent[] = []
            for (const row of body.results ?? []) {
                const key = eventPackageKey(row.id)
                if (key) events.push({packageKey: key, at: null})
            }
            return {
                events,
                cursor: body.last_seq == null ? cursor : String(body.last_seq),
                cursorTime: new Date(),
                headTime: null,
            }
        },
    },
}

/** `@scope/name` -> `@scope%2Fname`, which is how the registry wants a scoped package spelled. */
function encodePackageName(name: string): string {
    return name.replace(/\//g, '%2F')
}

/** CouchDB design documents share the database with packages; they are not packages. */
function eventPackageKey(id: string | undefined): string | null {
    if (!id || id.startsWith('_')) return null
    try {
        return fromRegistryName('npm', id).packageKey
    } catch {
        return null
    }
}

/** Exported for the tests: the pure packument -> FetchedPackage mapping. */
export function packageFromPackument(doc: Packument): FetchedPackage {
    const time = doc.time ?? {}
    const versionDocs = doc.versions ?? {}
    const registryLatest = stringOrUndefined(doc['dist-tags']?.latest)

    const raw = Object.entries(versionDocs).map(([version, versionDoc]) => ({
        version,
        releasedAt: toDate(time[version]),
        // `license` is the modern field; `licenses[]` is the pre-2014 spelling still on old packages.
        licenses: normaliseLicenses(versionDoc?.license ?? versionDoc?.licenses),
        prerelease: isPrerelease('npm', version),
        // npm has no yank: an unpublished version simply leaves the packument. `deprecated` is a
        // warning to humans, not a withdrawal, so it does not affect `latest`.
        yanked: false,
    }))

    const packageLicenses = pickPackageLicenses(doc, raw, registryLatest)
    const versions: FetchedVersion[] = raw.map(v => ({
        ...v,
        licenses: v.licenses.length > 0 ? v.licenses : packageLicenses,
    }))

    return {
        description: stringOrUndefined(doc.description),
        homepageUrl: stringOrUndefined(doc.homepage),
        repoUrl: normaliseRepoUrl(doc.repository),
        licenses: packageLicenses,
        versions,
        registryLatest,
        sources: [SOURCE],
    }
}

function pickPackageLicenses(
    doc: Packument,
    versions: {version: string; licenses: string[]}[],
    registryLatest: string | undefined,
): string[] {
    const top = normaliseLicenses(doc.license ?? doc.licenses)
    if (top.length > 0) return top
    const latest = registryLatest ? versions.find(v => v.version === registryLatest) : undefined
    if (latest && latest.licenses.length > 0) return latest.licenses
    // Some old packages only ever declared a license on individual versions.
    return versions.findLast(v => v.licenses.length > 0)?.licenses ?? []
}
