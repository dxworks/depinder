import fs from 'fs'
import path from 'path'

/**
 * Negative cache: the library keys whose registry lookup failed, and when.
 *
 * A registry that answers 404 — or does not answer at all — for a library will do the same on the
 * next run, and a lookup that fails is the most expensive kind: Maven Central's search API stalls
 * for its full timeout before the fallback chain gives up. Without this file every failure was
 * paid again on every run, so a "warm" cache still spent most of its time on the libraries it
 * could never fill. Successful lookups live in the positive cache; this holds only the misses,
 * next to it, as `cache/misses.json` mapping key to the failure's timestamp.
 *
 * A miss expires after `MISS_TTL_HOURS`, so a library published after the failure is picked up
 * within a day, and `--refresh` bypasses it entirely. A rate limit (429) is never recorded: that
 * says nothing about the library.
 */

export const MISS_TTL_HOURS = 24
const FILE_NAME = 'misses.json'

export interface MissCache {
    has: (key: string) => boolean
    set: (key: string) => void
    load: () => void
    write: () => void
}

function file(): string {
    return path.resolve(process.cwd(), 'cache', FILE_NAME)
}

let misses: Map<string, number> | undefined
let dirty = false

function loaded(): Map<string, number> {
    if (misses) return misses
    misses = new Map()
    try {
        if (fs.existsSync(file())) {
            const json = JSON.parse(fs.readFileSync(file(), 'utf8'))
            for (const [key, at] of Object.entries(json)) {
                if (typeof at === 'number') misses.set(key, at)
            }
        }
    } catch (e) {
        // An unreadable file costs nothing but a few repeated lookups; start empty.
        misses = new Map()
    }
    return misses
}

function expired(at: number, now: number): boolean {
    return now - at > MISS_TTL_HOURS * 60 * 60 * 1000
}

export const missCache: MissCache = {
    has(key: string): boolean {
        const at = loaded().get(key)
        return at !== undefined && !expired(at, Date.now())
    },
    set(key: string): void {
        loaded().set(key, Date.now())
        dirty = true
    },
    load(): void {
        loaded()
    },
    write(): void {
        if (!dirty) return
        const now = Date.now()
        const live = Object.fromEntries([...loaded()].filter(([, at]) => !expired(at, now)))
        fs.mkdirSync(path.dirname(file()), {recursive: true})
        fs.writeFileSync(file(), JSON.stringify(live))
        dirty = false
    },
}

/** The no-op twin of `noCache`, for runs that opt out of caching altogether. */
export const noMissCache: MissCache = {
    has: () => false,
    set: () => { /* nothing to remember */ },
    load: () => { /* nothing to load */ },
    write: () => { /* nothing to write */ },
}

/** For tests. */
export function resetMissCache(): void {
    misses = undefined
    dirty = false
}
