import {fromRegistryName, HttpError, type FetchContext} from '@depinder/core'
import type {FeedEvent, FeedResult, FeedSpec} from './types.js'

/**
 * gem's freshness: the compact index, `https://rubygems.org/versions`: 23 MB of append-only
 * text with `accept-ranges: bytes`. Downloading it every two minutes would be absurd, so the
 * cursor is a byte offset and each poll is a `HEAD` for the current size followed by a `Range`
 * request for the bytes appended since — see `poll` for why the `HEAD` is not optional. Like
 * npm's, its lines carry no timestamp, so `cursorTime` is the wall-clock time of the read: the lag
 * on `/feeds` answers "how long since we looked", not "how far behind the head are we".
 */

const COMPACT_INDEX_URL = 'https://rubygems.org/versions'
const SOURCE = 'rubygems.org'

export const gemFeed: FeedSpec = {
    mode: 'feed',
    intervalMs: 120_000,

    /**
     * The current size of the compact index, in bytes: everything before it is already in the
     * packages we hold.
     */
    async initialCursor(ctx: FetchContext): Promise<string> {
        return String(await compactIndexSize(ctx))
    },

    /**
     * The bytes appended since the stored offset.
     *
     * Every tick starts by asking how long the file is now, and that is not belt-and-braces:
     * rubygems.org is fronted by Fastly, which answers an unsatisfiable `Range` with **200 and
     * the whole 23 MB body** rather than the 416 the RFC calls for (probed 2026-09-16). Since
     * "the cursor is exactly at the end" is the normal answer on a quiet two-minute tick, a
     * bare `Range: bytes=<cursor>-` would download the entire index over and over. Comparing
     * against the size first turns that case into no request at all, and lets the range be
     * closed (`<cursor>-<end>`) so a rebuilt index is a mismatch we can see rather than 23 MB
     * we have to swallow.
     *
     * The cursor always lands on a newline boundary because only whole lines are ever
     * consumed, so a partial line at the end of a batch is left for the next poll instead of
     * being parsed half-read.
     */
    async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
        const offset = parseNumber(cursor) ?? 0
        const total = await compactIndexSize(ctx)
        const now = new Date()

        if (total === offset) return {events: [], cursor, cursorTime: now, headTime: null}
        if (total < offset) {
            // The index is shorter than our offset, so it is not the file the offset was
            // measured against. Re-anchor at the new head rather than replaying history.
            ctx.log.warn('rubygems compact index is shorter than the cursor, re-anchoring', {cursor, total})
            return {events: [], cursor: String(total), cursorTime: now, headTime: null}
        }

        const response = await ctx.http.get(COMPACT_INDEX_URL, {
            headers: {range: `bytes=${offset}-${total - 1}`, accept: 'text/plain'},
        })

        // A conforming cache answers 416 when the range is unsatisfiable. Fastly does not, but
        // the feed should not depend on which CDN is in front of rubygems today.
        if (response.status === 416) {
            return {events: [], cursor, cursorTime: now, headTime: null}
        }

        // 200 means the range was ignored — the index was rebuilt between the two requests.
        // Re-anchor at what we were served instead of turning 23 MB of history into events.
        if (response.status === 200) {
            const head = Buffer.byteLength(response.text, 'utf8')
            ctx.log.warn('rubygems compact index was rebuilt, re-anchoring at the head', {cursor, head})
            return {events: [], cursor: String(head), cursorTime: now, headTime: null}
        }

        if (response.status !== 206) {
            throw new HttpError(
                `${SOURCE} returned ${response.status} for the compact index`,
                response.url,
                response.status,
            )
        }

        const {consumedBytes, names} = parseCompactIndex(response.text)
        const events: FeedEvent[] = []
        for (const gem of names) {
            const packageKey = eventPackageKey(gem)
            if (packageKey) events.push({packageKey, at: null})
        }
        return {
            events,
            cursor: String(offset + consumedBytes),
            // Compact index lines carry no timestamp: freshness is "when we last read it".
            cursorTime: now,
            headTime: null,
        }
    },
}

/**
 * How many bytes the compact index is right now. A `HEAD` is enough and costs no body; the
 * one-byte `Range` request is the fallback for a cache that answers `HEAD` without a
 * `content-length`.
 */
async function compactIndexSize(ctx: FetchContext): Promise<number> {
    const head = await ctx.http.request(COMPACT_INDEX_URL, {method: 'HEAD'})
    if (head.ok) {
        const length = parseNumber(head.headers.get('content-length'))
        if (length !== null) return length
    }

    const probe = await ctx.http.get(COMPACT_INDEX_URL, {headers: {range: 'bytes=0-0', accept: 'text/plain'}})
    const total = totalFromContentRange(probe.headers.get('content-range'))
    if (total === null) {
        throw new HttpError(
            `${SOURCE} did not report the size of the compact index (status ${probe.status})`,
            probe.url,
            probe.status,
        )
    }
    return total
}

/**
 * The gem names in a slice of the compact index, and how many bytes of it were whole lines.
 *
 * Lines are `<name> <comma-separated versions, a leading '-' marks a yank> <md5>`. Only the name
 * matters to us: any line mentioning a gem means that gem changed, and `fetchPackage` re-reads the
 * whole version list anyway. Exported for the tests.
 */
export function parseCompactIndex(text: string): {consumedBytes: number; names: string[]} {
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) return {consumedBytes: 0, names: []}

    const complete = text.slice(0, lastNewline + 1)
    const names: string[] = []
    const seen = new Set<string>()

    for (const line of complete.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // The file starts with a `created_at: …` line and a `---` separator. They are only in
        // range when the cursor is 0, but a rebuilt index can put us there.
        if (trimmed === '---' || trimmed.startsWith('created_at:')) continue
        const name = trimmed.split(' ', 1)[0]
        if (!name || seen.has(name)) continue
        seen.add(name)
        names.push(name)
    }

    return {consumedBytes: Buffer.byteLength(complete, 'utf8'), names}
}

function eventPackageKey(name: string): string | null {
    try {
        return fromRegistryName('gem', name).packageKey
    } catch {
        return null
    }
}

/** `bytes 0-0/23388275` -> `23388275`; also `bytes * /23388275`, which is what a 416 carries. */
function totalFromContentRange(value: string | null): number | null {
    if (!value) return null
    const match = /\/(\d+)\s*$/.exec(value)
    return match ? Number(match[1]) : null
}

function parseNumber(value: string | null | undefined): number | null {
    if (value == null) return null
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
