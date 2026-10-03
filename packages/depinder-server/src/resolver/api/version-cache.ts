import type {CompactVersion} from '../db/rows.js'

/**
 * The version tuples of recently answered packages, held in this process.
 *
 * `/resolve` reads the `package` rows it needs anyway, and every one of them carries `fetched_at`.
 * That is the whole validation: an entry is used only when the row read *this request* is
 * `resolved` and its `fetched_at` is exactly the one the entry was stored under. The worker stamps
 * a new `fetched_at` on the package row in the same transaction that replaces its versions — there
 * is no path in the service that writes `package_version` without it — so a matching `fetched_at`
 * means the versions have not moved. A poll answered 304 moves `as_of` and never `fetched_at`, so it
 * does not cost the cache anything; a row never fully fetched has no `fetched_at` and is never held.
 *
 * That makes the cache safe across processes and instances by construction: correctness never
 * depends on what is in here, only on the row that was just read. A second api instance, a
 * restart, or a cache switched off with `PAYLOAD_CACHE_MAX_PACKAGES=0` all answer identically —
 * they just ask the database more often.
 *
 * The bound is an entry count, and eviction is least-recently-used: a `Map` iterates in insertion
 * order, so re-inserting on a hit moves an entry to the young end and the oldest key is the first
 * one iteration yields.
 */
export interface VersionCache {
    /** The versions held for `key`, but only if they were stored under exactly this `fetchedAt`. */
    get(key: string, fetchedAt: Date): CompactVersion[] | undefined
    set(key: string, fetchedAt: Date, versions: CompactVersion[]): void
    /** Entries held. For tests and for the log line at boot. */
    readonly size: number
}

interface Entry {
    fetchedAt: number
    versions: CompactVersion[]
}

/** A cache holding at most `maxPackages` packages. 0 (or less) returns one that holds nothing. */
export function createVersionCache(maxPackages: number): VersionCache {
    if (maxPackages <= 0) {
        return {
            get: () => undefined,
            set: () => undefined,
            get size(): number {
                return 0
            },
        }
    }

    const entries = new Map<string, Entry>()

    return {
        get(key, fetchedAt) {
            const entry = entries.get(key)
            if (!entry || entry.fetchedAt !== fetchedAt.getTime()) return undefined
            entries.delete(key)
            entries.set(key, entry)
            return entry.versions
        },

        set(key, fetchedAt, versions) {
            entries.delete(key)
            entries.set(key, {fetchedAt: fetchedAt.getTime(), versions})
            while (entries.size > maxPackages) {
                const oldest = entries.keys().next()
                if (oldest.done) break
                entries.delete(oldest.value)
            }
        },

        get size(): number {
            return entries.size
        },
    }
}
