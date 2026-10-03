import {fromRegistryName, HttpError, toDate, type FetchContext} from '@depinder/core'
import {decodeMethodResponse, encodeMethodCall, type XmlRpcValue} from './pypi-xmlrpc.js'
import type {FeedEvent, FeedResult, FeedSpec} from './types.js'

/**
 * pypi's freshness: PyPI's XML-RPC changelog, the one part of the XML-RPC interface that is still
 * supported for mirroring. Its cursor is a monotonic "serial" and its entries carry unix
 * timestamps, so `cursorTime` is a real head-lag rather than a wall clock. The XML-RPC encoding
 * and decoding live in `pypi-xmlrpc.ts`.
 */

const SOURCE = 'pypi.org'

/** PyPI's XML-RPC endpoint is the same path as the JSON API; the method is what distinguishes it. */
const XMLRPC_URL = 'https://pypi.org/pypi'

export const pypiFeed: FeedSpec = {
    mode: 'feed',
    intervalMs: 60_000,

    /** The current changelog serial. Everything below it is already in the packages we hold. */
    async initialCursor(ctx: FetchContext): Promise<string> {
        const value = await xmlrpcCall(ctx, 'changelog_last_serial', [])
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new Error(`${SOURCE} returned a non-integer changelog_last_serial: ${JSON.stringify(value)}`)
        }
        return String(Math.trunc(value))
    },

    async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
        const serial = Number.parseInt(cursor, 10)
        if (!Number.isFinite(serial)) throw new Error(`pypi feed cursor "${cursor}" is not an integer`)

        const value = await xmlrpcCall(ctx, 'changelog_since_serial', [serial])
        if (!Array.isArray(value)) {
            throw new Error(`${SOURCE} returned a non-array changelog_since_serial: ${typeof value}`)
        }

        let maxSerial = serial
        let maxTime: number | null = null
        // A single upload produces several rows ("new release", "add py3 file", "add source
        // file"); the worker only needs to know the package changed, so they collapse to one
        // event carrying the newest time seen for that package.
        const latestPerPackage = new Map<string, Date | null>()

        for (const row of value) {
            if (!Array.isArray(row)) continue
            const [name, , timestamp, , rowSerial] = row
            if (typeof rowSerial === 'number' && rowSerial > maxSerial) maxSerial = Math.trunc(rowSerial)
            const at = typeof timestamp === 'number' ? toDate(timestamp) : null
            if (at && (maxTime === null || at.getTime() > maxTime)) maxTime = at.getTime()
            if (typeof name !== 'string') continue
            const packageKey = eventPackageKey(name)
            if (!packageKey) continue
            const previous = latestPerPackage.get(packageKey)
            if (previous === undefined || (at && (previous === null || at.getTime() > previous.getTime()))) {
                latestPerPackage.set(packageKey, at)
            }
        }

        const events: FeedEvent[] = [...latestPerPackage].map(([packageKey, at]) => ({packageKey, at}))
        return {
            events,
            cursor: String(maxSerial),
            cursorTime: maxTime === null ? null : new Date(maxTime),
            // PyPI publishes no head time of its own; the newest serial we consumed is it.
            headTime: null,
        }
    },
}

function eventPackageKey(name: string): string | null {
    try {
        return fromRegistryName('pypi', name).packageKey
    } catch {
        return null
    }
}

async function xmlrpcCall(ctx: FetchContext, method: string, params: (number | string)[]): Promise<XmlRpcValue> {
    const response = await ctx.http.request(XMLRPC_URL, {
        method: 'POST',
        headers: {'content-type': 'text/xml', accept: 'text/xml'},
        body: encodeMethodCall(method, params),
    })
    if (!response.ok) {
        throw new HttpError(`${SOURCE} returned ${response.status} for ${method}`, response.url, response.status)
    }
    return decodeMethodResponse(response.text)
}
