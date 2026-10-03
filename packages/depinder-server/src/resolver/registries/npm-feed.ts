import {fromRegistryName, HttpError, type FetchContext} from '@depinder/core'
import type {FeedEvent, FeedResult, FeedSpec} from './types.js'

/**
 * npm's freshness: the CouchDB change feed on replicate.npmjs.com. Its cursor is an opaque
 * sequence number and, unlike every other feed we consume, its entries carry no timestamps. So
 * `cursorTime` is the wall-clock time of the last successful read: for npm, the lag on `/feeds`
 * answers "how long since we looked", not "how far behind the head are we". Since the loop starts
 * at the current head and reads every 30 s, the two are the same number in practice — they only
 * diverge while draining a backlog after downtime, where the reported lag is optimistic.
 */

const REPLICATE_URL = 'https://replicate.npmjs.com'
const CHANGES_LIMIT = 1000

interface ChangesResponse {
    results?: {seq?: number | string; id?: string; deleted?: boolean}[]
    last_seq?: number | string
}

// [14] The feed half of [11]: a _changes cursor every 30s; whatever changed is re-queued at priority 20 — back to [6].
export const npmFeed: FeedSpec = {
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
