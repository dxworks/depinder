import {fromRegistryName, HttpError, toDate, type FetchContext} from '@depinder/core'
import type {FeedEvent, FeedResult, FeedSpec} from './types.js'

/**
 * golang's freshness: `index.golang.org`, the module index. Unusually for the feeds we consume it
 * carries a real timestamp per event, so `cursorTime` is an honest "how far behind the head are
 * we" rather than npm's "how long since we looked".
 */

const INDEX_URL = 'https://index.golang.org/index'
const INDEX_LIMIT = 2000

interface IndexRow {
    Path?: string
    Version?: string
    Timestamp?: string
}

export const golangFeed: FeedSpec = {
    mode: 'feed',
    intervalMs: 60_000,

    /** The index is addressed by time, so the head is simply "now". */
    async initialCursor(): Promise<string> {
        return new Date().toISOString()
    },

    /**
     * One batch of the module index. It is ordered by `Timestamp`, so the newest row of the
     * batch is the next cursor; a full batch means there is more, which the next tick reads.
     */
    async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
        const url = `${INDEX_URL}?since=${encodeURIComponent(cursor)}&limit=${INDEX_LIMIT}`
        const response = await ctx.http.get(url, {headers: {accept: 'text/plain'}})
        if (!response.ok) {
            throw new HttpError(
                `index.golang.org returned ${response.status} for the module index`,
                response.url,
                response.status,
            )
        }

        // Newline-delimited JSON, one `{Path, Version, Timestamp}` per published module version.
        // A module that published three versions in the batch is one package to re-fetch, so
        // the events are deduplicated by path, keeping the newest timestamp seen for it.
        const byKey = new Map<string, FeedEvent>()
        let lastTimestamp: string | undefined
        for (const line of response.text.split('\n')) {
            const row = parseIndexRow(line)
            if (!row?.Path) continue
            if (row.Timestamp) lastTimestamp = row.Timestamp
            const packageKey = eventPackageKey(row.Path)
            if (!packageKey) continue
            const at = toDate(row.Timestamp)
            const existing = byKey.get(packageKey)
            if (existing) existing.at = at ?? existing.at
            else byKey.set(packageKey, {packageKey, at})
        }

        const cursorTime = toDate(lastTimestamp)
        return {
            events: [...byKey.values()],
            cursor: lastTimestamp ?? cursor,
            cursorTime,
            headTime: null,
        }
    },
}

function parseIndexRow(line: string): IndexRow | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed) as IndexRow
    } catch {
        // A truncated last line would only happen if the index changed its framing; skipping it
        // costs one re-fetch on the next tick, whereas throwing would stall the cursor.
        return null
    }
}

/** Module paths are split into namespace/name by `purl.ts`, never by hand. */
function eventPackageKey(path: string): string | null {
    try {
        return fromRegistryName('golang', path).packageKey
    } catch {
        return null
    }
}
