import {HttpError} from '@depinder/core'
import {normaliseLicenses} from './shared.js'
import type {FetchContext} from './types.js'

/**
 * deps.dev, used as a license source for ecosystems whose registry of record publishes none.
 *
 * The Go module proxy is a content server: it serves zips, `.info` files and version lists, and
 * has no opinion about licensing at all. deps.dev has already scanned the module zips, so one
 * request per module version gives us the `licenses[]` the proxy cannot. That is the only reason
 * this file exists, and it is why `golang.ts` reports `sources: ['proxy.golang.org',
 * 'api.deps.dev']`: two hosts contributed the facts, and the provenance has to say so.
 *
 * This is not a `Registry`. It has no feed and it is never the registry of record — freshness for
 * a Go module still comes from index.golang.org.
 */

export const DEPS_DEV_SOURCE = 'api.deps.dev'

const BASE_URL = 'https://api.deps.dev/v3/systems'

interface VersionResponse {
    licenses?: unknown
}

/**
 * The licenses deps.dev knows for one version of one package.
 *
 * `null` means "deps.dev has no record of this version" (a 404), which is a normal answer for a
 * version it has not scanned yet; it is not an error and must not fail the package. It is kept
 * apart from `[]` — scanned, no license found — because one may change in a few hours and the
 * other will not. Anything else that is not a 200 throws, so the queue retries rather than storing
 * "no license" as if it were a fact.
 *
 * `system` is a deps.dev system name (`go`, `npm`, `maven`, …). It defaults to `go` because Go is
 * the only ecosystem in this service that needs deps.dev; the parameter is there so the next one
 * does not have to rewrite the function.
 */
export async function fetchLicenses(
    name: string,
    version: string,
    ctx: FetchContext,
    system = 'go',
): Promise<string[] | null> {
    const url = `${BASE_URL}/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
    const response = await ctx.http.get(url)
    if (response.status === 404) return null
    if (!response.ok) {
        throw new HttpError(
            `${DEPS_DEV_SOURCE} returned ${response.status} for ${system} ${name}@${version}`,
            response.url,
            response.status,
        )
    }
    return normaliseLicenses(response.json<VersionResponse>().licenses)
}
