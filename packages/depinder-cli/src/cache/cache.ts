import {LibraryInfo} from '../extension-points/library-info'

export interface Cache {
    get: (key: string) => LibraryInfo | Promise<LibraryInfo> | undefined | any
    /**
     * Writes `value` under `key`. `updatedAt` (epoch milliseconds) is the moment its facts were last
     * known to match the registry, which is what the max age is measured from; it defaults to now,
     * which is right for anything fetched from the registry a moment ago. A resolver answer passes
     * the server's own `confirmed_at` instead, so facts the server has held for a while are not made
     * to look fresh by having just been copied here.
     */
    set: (key: string, value: LibraryInfo, updatedAt?: number) => void | Promise<void>
    has: (key: string) => boolean | Promise<boolean>
    /**
     * True when an entry exists under `key` but is past the cache max age, so `has` and `get`
     * ignore it. Only counters and log lines read it; a cache without ages leaves it out.
     */
    isExpired?: (key: string) => boolean | Promise<boolean>
    load: () => void | Promise<void>,
    /**
     * Makes everything written so far durable and LEAVES THE CACHE USABLE.
     *
     * Separate from `write` because `write` is also the teardown step and may release what the
     * cache holds open; calling it from the mid-run checkpoint would fail every remaining lookup.
     * A cache whose `set` is already durable (SQLite) implements this as a no-op; one that batches
     * in memory would serialise here.
     * Optional: a cache that does not implement it simply keeps the pre-checkpoint behaviour of
     * only becoming durable at the end of the run.
     */
    flush?: () => void | Promise<void>,
    write: () => void | Promise<void>,
}

export const noCache: Cache = {
    get(key: string): LibraryInfo | undefined {
        return undefined
    },
    set(key: string, value: LibraryInfo, updatedAt?: number): void {

    },
    has(key: string): boolean {
        return false
    },
    load() {
    },
    flush() {
    },
    write() {
    },
}