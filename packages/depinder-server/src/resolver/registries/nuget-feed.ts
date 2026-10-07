import {
    fromRegistryName,
    HttpError,
    mapWithConcurrency,
    stringOrUndefined,
    toDate,
    type FetchContext,
} from '@depinder/core'
import type {FeedEvent, FeedResult, FeedSpec} from './types.js'

/** nuget's freshness: the catalog, a time-ordered log of every package commit on nuget.org. */

const CATALOG_INDEX_URL = 'https://api.nuget.org/v3/catalog0/index.json'
const SOURCE = 'api.nuget.org'

/** Catalog pages fetched at once. The limiter caps the total anyway. */
const PAGE_CONCURRENCY = 4

/** Catalog pages consumed in one poll. A backlog drains over the following ticks. */
const MAX_FEED_PAGES = 20

interface CatalogIndexPage {
    '@id'?: unknown
    commitTimeStamp?: unknown
}

interface CatalogIndex {
    commitTimeStamp?: unknown
    items?: CatalogIndexPage[]
}

interface CatalogItem {
    commitTimeStamp?: unknown
    'nuget:id'?: unknown
}

interface CatalogPage {
    items?: CatalogItem[]
}

export const nugetFeed: FeedSpec = {
    mode: 'feed',
    intervalMs: 60_000,

    /** The catalog's head commit. Everything committed before it is already in our packages. */
    async initialCursor(ctx: FetchContext): Promise<string> {
        const index = await readCatalogIndex(ctx)
        const head = stringOrUndefined(index.commitTimeStamp)
        if (!head) throw new Error(`${SOURCE} catalog index has no commitTimeStamp`)
        return head
    },

    async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
        const index = await readCatalogIndex(ctx)
        const headTime = toDate(index.commitTimeStamp)

        // Catalog timestamps are UTC ISO-8601 with a fixed number of fractional digits, so a
        // string comparison orders them exactly as the instants do.
        const due = (index.items ?? [])
            .filter(page => {
                const at = stringOrUndefined(page.commitTimeStamp)
                return at !== undefined && at > cursor
            })
            .sort((a, b) => String(a.commitTimeStamp).localeCompare(String(b.commitTimeStamp)))
            .slice(0, MAX_FEED_PAGES)

        const pages = await mapWithConcurrency(due, PAGE_CONCURRENCY, async page => {
            const url = stringOrUndefined(page['@id'])
            if (!url) return {items: []} as CatalogPage
            const response = await ctx.http.get(url)
            if (!response.ok) {
                throw new HttpError(
                    `${SOURCE} returned ${response.status} for a catalog page`,
                    response.url,
                    response.status,
                )
            }
            return response.json<CatalogPage>()
        })

        let newCursor = cursor
        const latestPerPackage = new Map<string, Date | null>()

        for (const page of pages) {
            for (const item of page.items ?? []) {
                const at = stringOrUndefined(item.commitTimeStamp)
                if (at === undefined || at <= cursor) continue
                if (at > newCursor) newCursor = at
                const id = stringOrUndefined(item['nuget:id'])
                if (!id) continue
                const packageKey = eventPackageKey(id)
                if (!packageKey) continue
                const date = toDate(at)
                const previous = latestPerPackage.get(packageKey)
                if (previous === undefined || (date && (previous === null || date > previous))) {
                    latestPerPackage.set(packageKey, date)
                }
            }
        }

        const events: FeedEvent[] = [...latestPerPackage].map(([packageKey, at]) => ({packageKey, at}))
        return {
            events,
            cursor: newCursor,
            cursorTime: newCursor === cursor ? null : toDate(newCursor),
            headTime,
        }
    },
}

async function readCatalogIndex(ctx: FetchContext): Promise<CatalogIndex> {
    const response = await ctx.http.get(CATALOG_INDEX_URL)
    if (!response.ok) {
        throw new HttpError(
            `${SOURCE} returned ${response.status} for the catalog index`,
            response.url,
            response.status,
        )
    }
    return response.json<CatalogIndex>()
}

function eventPackageKey(id: string): string | null {
    try {
        return fromRegistryName('nuget', id).packageKey
    } catch {
        return null
    }
}
