import {HttpError, type FetchContext} from '@depinder/core'
import {modified, notModified} from './poll-validators.js'
import type {FeedSpec, PollResult, PollTarget} from './types.js'

/**
 * cargo's freshness. crates.io has no change feed. What there is, is the sparse registry index on
 * a CDN — one small text file per crate, rewritten on every publish and yank — so the feed is
 * `poll` mode: a conditional GET on that file per tracked crate. The index is the cheap thing to
 * ask; the API is what core's fetcher reads once the index says something moved.
 */

const INDEX_URL = 'https://index.crates.io'
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

export const cargoPoll: FeedSpec = {
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
