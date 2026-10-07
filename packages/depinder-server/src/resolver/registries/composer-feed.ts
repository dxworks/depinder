import {fromRegistryName, HttpError, stringOrUndefined, toDate, type FetchContext} from '@depinder/core'
import type {FeedEvent, FeedResult, FeedSpec} from './types.js'

/** composer's freshness: Packagist's metadata change list, read from a timestamp cursor. */

const CHANGES_URL = 'https://packagist.org/metadata/changes.json'

/** Packagist's cursor is unix seconds × 10 000. Its own `timestamp` field is in the same unit. */
const CURSOR_SCALE = 10_000

interface ChangesResponse {
    actions?: {type?: unknown; package?: unknown; time?: unknown}[]
    timestamp?: unknown
    error?: unknown
}

export const composerFeed: FeedSpec = {
    mode: 'feed',
    intervalMs: 60_000,

    /**
     * Packagist will not hand out its clock on its own, so the head is read by asking for a
     * minute of changes and keeping the `timestamp` it answers with. A `since` it considers
     * invalid still comes back with that timestamp, which is the whole point of the error.
     */
    async initialCursor(ctx: FetchContext): Promise<string> {
        const since = (Math.floor(Date.now() / 1000) - 60) * CURSOR_SCALE
        const response = await ctx.http.get(`${CHANGES_URL}?since=${since}`)
        const body = response.text ? response.json<ChangesResponse>() : {}
        const timestamp = numberOrUndefined(body.timestamp)
        if (timestamp !== undefined) return String(timestamp)
        if (!response.ok) {
            throw new HttpError(
                `packagist.org returned ${response.status} for the changes head`,
                response.url,
                response.status,
            )
        }
        return String(Math.floor(Date.now() / 1000) * CURSOR_SCALE)
    },

    async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
        const response = await ctx.http.get(`${CHANGES_URL}?since=${encodeURIComponent(cursor)}`)
        const body = response.text ? response.json<ChangesResponse>() : {}
        const timestamp = numberOrUndefined(body.timestamp)

        if (!response.ok) {
            // A cursor older than the window Packagist keeps is answered with a 400 carrying
            // the current timestamp. Failing forever on that would freeze the feed, so we jump
            // to the head and say so: the gap is repaired by the next full re-fetch of each
            // package, not by crawling a million names.
            if (timestamp !== undefined) {
                ctx.log.warn('packagist rejected the feed cursor, restarting from its head', {
                    cursor,
                    status: response.status,
                    head: timestamp,
                })
                return {events: [], cursor: String(timestamp), cursorTime: null, headTime: headTimeOf(timestamp)}
            }
            throw new HttpError(
                `packagist.org returned ${response.status} for changes.json`,
                response.url,
                response.status,
            )
        }

        const actions = Array.isArray(body.actions) ? body.actions : []
        const newCursor = timestamp === undefined ? cursor : String(timestamp)
        const headTime = timestamp === undefined ? null : headTimeOf(timestamp)

        if (actions.some(action => action.type === 'resync')) {
            // `resync` means "your view is stale, read everything again". Crawling all of
            // Packagist is never the right answer to that; the packages we track are re-read
            // on their own schedule anyway.
            ctx.log.warn('packagist asked for a full resync; skipping this batch', {cursor})
            return {events: [], cursor: newCursor, cursorTime: null, headTime}
        }

        let maxTime: number | null = null
        const latestPerPackage = new Map<string, Date | null>()

        for (const action of actions) {
            const type = stringOrUndefined(action.type)
            if (type !== 'update' && type !== 'delete') continue
            const at = toDate(numberOrUndefined(action.time))
            if (at && (maxTime === null || at.getTime() > maxTime)) maxTime = at.getTime()

            const name = stringOrUndefined(action.package)
            if (!name) continue
            // `vendor/name~dev` and `vendor/name` are two metadata files for one package.
            const packageKey = eventPackageKey(name.replace(/~dev$/, ''))
            if (!packageKey) continue
            const previous = latestPerPackage.get(packageKey)
            if (previous === undefined || (at && (previous === null || at > previous))) {
                latestPerPackage.set(packageKey, at)
            }
        }

        const events: FeedEvent[] = [...latestPerPackage].map(([packageKey, at]) => ({packageKey, at}))
        return {
            events,
            cursor: newCursor,
            cursorTime: maxTime === null ? null : new Date(maxTime),
            headTime,
        }
    },
}

/** The cursor unit is unix seconds × 10 000, so dividing it back gives Packagist's own head time. */
function headTimeOf(timestamp: number): Date | null {
    return toDate(Math.floor(timestamp / CURSOR_SCALE))
}

function eventPackageKey(name: string): string | null {
    if (!name.includes('/')) return null
    try {
        return fromRegistryName('composer', name).packageKey
    } catch {
        return null
    }
}

function numberOrUndefined(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return undefined
}
