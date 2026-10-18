import {LibraryInfo} from '../extension-points/library-info'

/**
 * The library cache: rows of the SQLite `libs` table, seen through a freshness cutoff. Every call
 * is synchronous, and every `set` is committed on its own, so there is nothing to load or flush.
 */
export interface Cache {
    get: (key: string) => LibraryInfo | undefined
    /**
     * Writes `value` under `key`. `updatedAt` (epoch milliseconds) is the moment its facts were last
     * known to match the registry, which is what the max age is measured from; it defaults to now,
     * which is right for anything fetched from the registry a moment ago. A resolver answer passes
     * the server's own `confirmed_at` instead, so facts the server has held for a while are not made
     * to look fresh by having just been copied here.
     */
    set: (key: string, value: LibraryInfo, updatedAt?: number) => void
    has: (key: string) => boolean
    /**
     * True when an entry exists under `key` but is past the cache max age, so `has` and `get`
     * ignore it. Only counters and log lines read it.
     */
    isExpired: (key: string) => boolean
}
