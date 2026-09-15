import {MISS_TTL_HOURS, sharedCacheDb} from './sqlite-cache'

/**
 * Negative cache: the library keys whose registry lookup failed, and when.
 *
 * A registry that answers 404 — or does not answer at all — for a library will do the same on the
 * next run, and a lookup that fails is the most expensive kind: Maven Central's search API stalls
 * for its full timeout before the fallback chain gives up. Without this every failure was paid
 * again on every run, so a "warm" cache still spent most of its time on the libraries it could
 * never fill. Successful lookups live in the `libs` table; this is the `misses` table of the same
 * database, key to the failure's timestamp.
 *
 * A miss expires after `MISS_TTL_HOURS`, so a library published after the failure is picked up
 * within a day, and `--refresh` bypasses it entirely. A rate limit (429) is never recorded: that
 * says nothing about the library.
 */

export {MISS_TTL_HOURS}

export interface MissCache {
    has: (key: string) => boolean
    set: (key: string) => void
    load: () => void
    write: () => void
}

export const missCache: MissCache = {
    has(key: string): boolean {
        return sharedCacheDb().hasMiss(key)
    },
    set(key: string): void {
        sharedCacheDb().setMiss(key)
    },
    load(): void {
        sharedCacheDb()
    },
    // A set is durable on its own; writing is the moment to drop what has expired.
    write(): void {
        sharedCacheDb().pruneMisses()
    },
}

/** The no-op twin of `noCache`, for runs that opt out of caching altogether. */
export const noMissCache: MissCache = {
    has: () => false,
    set: () => { /* nothing to remember */ },
    load: () => { /* nothing to load */ },
    write: () => { /* nothing to write */ },
}
