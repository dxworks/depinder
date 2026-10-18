import {HttpError} from '../http/client.js'
import {registryName} from '../purl.js'
import {isPrerelease} from './latest.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './normalise.js'
import type {FetchedPackage, FetchedVersion, PackageFetcher} from './types.js'

/**
 * cargo — facts from crates.io, the registry of record.
 *
 * `GET /api/v1/crates/<name>` carries the crate and every version in one response, so a crate
 * costs exactly one request. crates.io asks for an identifying User-Agent and about one request a
 * second; both are the HTTP client's job (with the caller's cargo limit), not this file's.
 */

const API_URL = 'https://crates.io/api/v1/crates'
const SOURCE = 'crates.io'

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

export const cargoFetcher: PackageFetcher = {
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
