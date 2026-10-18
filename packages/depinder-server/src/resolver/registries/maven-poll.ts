import {HttpError, mavenMetadataUrl, type FetchContext} from '@depinder/core'
import {modified, notModified} from './poll-validators.js'
import type {FeedSpec, PollResult, PollTarget} from './types.js'

/**
 * maven's freshness. There is no change feed to consume: the Nexus incremental index chunks are
 * Lucene blobs. So the feed is `poll` mode, a conditional GET on `maven-metadata.xml`, which
 * Central answers with both an ETag and a Last-Modified.
 */

const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000

export const mavenPoll: FeedSpec = {
    mode: 'poll',
    intervalMs: POLL_INTERVAL_MS,

    /**
     * A conditional GET on the cheapest thing that changes when the artifact changes. Central
     * answers `maven-metadata.xml` with both an ETag and a Last-Modified, so both validators
     * are sent when we hold them.
     */
    async check(target: PollTarget, ctx: FetchContext): Promise<PollResult> {
        const url = mavenMetadataUrl(target.key)

        const headers: Record<string, string> = {accept: 'application/xml'}
        if (target.etag) headers['if-none-match'] = target.etag
        if (target.lastModified) headers['if-modified-since'] = target.lastModified

        const response = await ctx.http.get(url, {headers})
        if (response.status === 304) return notModified(target)
        if (response.status === 404) {
            // The artifact was fetched once, so this should not happen; Central does not
            // delete. Leave the package as it stands rather than acting on one odd answer.
            ctx.log.debug('maven-metadata.xml is gone', {package: target.packageKey, url})
            return {changed: false, confirmed: false}
        }
        if (!response.ok) {
            throw new HttpError(
                `repo1.maven.org returned ${response.status} for ${target.packageKey}`,
                response.url,
                response.status,
            )
        }

        return modified(target, response.headers)
    },
}
