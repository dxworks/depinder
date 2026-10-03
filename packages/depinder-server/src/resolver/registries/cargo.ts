import {HttpError} from './http.js'
import {isPrerelease} from './latest.js'
import {registryName} from '@depinder/core'
import {modified, normaliseLicenses, normaliseRepoUrl, notModified, stringOrUndefined, toDate} from './shared.js'
import type {FetchContext, FetchedPackage, FetchedVersion, PollResult, PollTarget, Registry} from './types.js'

/**
 * cargo — facts from crates.io, the registry of record.
 *
 * `GET /api/v1/crates/<name>` carries the crate and every version in one response, so a crate
 * costs exactly one request. crates.io asks for an identifying User-Agent and about one request a
 * second; both are `src/resolver/registries/http.ts`'s job (`RATE_LIMITS.cargo`), not this file's.
 *
 * There is no change feed. What there is, is the sparse registry index on a CDN — one small text
 * file per crate, rewritten on every publish and yank — so the feed is `poll` mode: a conditional
 * GET on that file per tracked crate. The index is the cheap thing to ask; the API is what we read
 * once the index says something moved.
 */

const API_URL = 'https://crates.io/api/v1/crates'
const INDEX_URL = 'https://index.crates.io'
const SOURCE = 'crates.io'

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

interface CrateVersion {
    num?: unknown
    created_at?: unknown
    license?: unknown
    yanked?: unknown
}

interface CrateResponse {
    crate?: {
        description?: unknown
        homepage?: unknown
        repository?: unknown
        max_stable_version?: unknown
        newest_version?: unknown
    }
    versions?: CrateVersion[]
}

export const cargoRegistry: Registry = {
    type: 'cargo',

    async fetchPackage(key, ctx) {
        const name = registryName(key)
        const response = await ctx.http.get(`${API_URL}/${encodeURIComponent(name)}`)
        if (response.status === 404) return null
        if (!response.ok) {
            throw new HttpError(`${SOURCE} returned ${response.status} for ${name}`, response.url, response.status)
        }
        return packageFromCrate(response.json<CrateResponse>())
    },

    feed: {
        mode: 'poll',
        intervalMs: POLL_INTERVAL_MS,

        /**
         * A conditional GET on the crate's sparse-index file. S3 answers it with an ETag (and a
         * Last-Modified); both are sent back when we hold them.
         */
        async check(target: PollTarget, ctx: FetchContext): Promise<PollResult> {
            const url = `${INDEX_URL}/${sparseIndexPath(target.key.name)}`

            const headers: Record<string, string> = {accept: 'text/plain'}
            if (target.etag) headers['if-none-match'] = target.etag
            if (target.lastModified) headers['if-modified-since'] = target.lastModified

            const response = await ctx.http.get(url, {headers})
            if (response.status === 304) return notModified(target)
            if (response.status === 404) {
                // The crate was fetched from the API once, so this is the index lagging a publish
                // or a crate that has been removed. Either way, leave the package as it stands.
                ctx.log.debug('crate missing from the sparse index', {package: target.packageKey, url})
                return {changed: false, confirmed: false}
            }
            if (!response.ok) {
                throw new HttpError(
                    `index.crates.io returned ${response.status} for ${target.packageKey}`,
                    response.url,
                    response.status,
                )
            }

            return modified(target, response.headers)
        },
    },
}

/**
 * Where a crate lives in the sparse index, per cargo's own rule: one- and two-character names get
 * a `1/` or `2/` bucket, three-character names get `3/<first letter>/`, and everything else is
 * bucketed by its first two and next two characters. All lowercase.
 *
 *   `a` -> `1/a`   `id` -> `2/id`   `log` -> `3/l/log`   `serde` -> `se/rd/serde`
 */
export function sparseIndexPath(name: string): string {
    const lower = name.toLowerCase()
    const encoded = encodeURIComponent(lower)
    if (lower.length === 1) return `1/${encoded}`
    if (lower.length === 2) return `2/${encoded}`
    if (lower.length === 3) return `3/${lower.slice(0, 1)}/${encoded}`
    return `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${encoded}`
}

/** Exported for the tests: the pure crates.io response -> FetchedPackage mapping. */
export function packageFromCrate(body: CrateResponse): FetchedPackage {
    const crate = body.crate ?? {}

    // crates.io lists versions newest first. Every version carries a `created_at`, so the order
    // does not decide anything, but `latest.ts` documents its undated tie-break as "the last one
    // in the list wins, because every registry we read lists versions oldest-first" — so hand it
    // a list that is oldest-first like all the others.
    const versions: FetchedVersion[] = []
    for (const version of body.versions ?? []) {
        const num = stringOrUndefined(version.num)
        if (!num) continue
        versions.push({
            version: num,
            releasedAt: toDate(version.created_at),
            // `license` is an SPDX expression: `MIT OR Apache-2.0`, or the older `MIT/Apache-2.0`
            // spelling. `normaliseLicenses` keeps an expression whole on purpose — splitting it
            // would claim the crate is under each of them, and an `OR` means it is under either.
            licenses: normaliseLicenses(version.license),
            prerelease: isPrerelease('cargo', num),
            yanked: version.yanked === true,
        })
    }
    versions.reverse()

    const registryLatest = stringOrUndefined(crate.max_stable_version) ?? stringOrUndefined(crate.newest_version)

    return {
        description: stringOrUndefined(crate.description),
        homepageUrl: stringOrUndefined(crate.homepage) ?? normaliseRepoUrl(crate.repository),
        repoUrl: normaliseRepoUrl(crate.repository),
        licenses: pickCrateLicenses(versions, registryLatest),
        versions,
        registryLatest,
        sources: [SOURCE],
    }
}

/**
 * crates.io states a license per version and none for the crate, so the crate's is the license of
 * the version it calls latest — falling back to the newest version anybody can still install.
 */
function pickCrateLicenses(versions: readonly FetchedVersion[], registryLatest: string | undefined): string[] {
    const designated = registryLatest ? versions.find(v => v.version === registryLatest) : undefined
    if (designated && designated.licenses.length > 0) return designated.licenses
    return versions.findLast(v => !v.yanked && v.licenses.length > 0)?.licenses ?? []
}
