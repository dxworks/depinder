import {DatabaseSync} from 'node:sqlite'
import fs from 'fs'
import path from 'path'
import {Cache} from './cache'
import {LibraryInfo} from '../extension-points/registrar'
import {depinderFolder} from '../utils/utils'

/**
 * The file-based cache: one SQLite database, global to the machine.
 *
 * It replaces `cache/libs.json` + `cache/misses.json` under the working directory. That pair had
 * two costs that grew with every run: `libs.json` reached 94 MB on a twelve-repository run and
 * was serialised WHOLE at every checkpoint, blocking the event loop for seconds; and a cache per
 * working directory meant the same packument was fetched once per project folder. This database
 * is written per row, so a checkpoint is free, and it lives in `~/.dxw/depinder/cache/`, so every
 * run on the machine shares it. It is the only cache: each machine has its own.
 *
 * `node:sqlite` is Node's own module (stable API, `ExperimentalWarning` still printed on Node 24;
 * `index.ts` silences that one warning). No native addon, nothing to compile per platform.
 *
 * `DEPINDER_CACHE_DB=<file>` points a run at another database — a per-run cache paired with a
 * Black Duck export, or a test's temporary one.
 *
 * Legacy JSON: when a database is created and `libs.json` sits next to it, `libs.json` and
 * `misses.json` are imported once. They are never deleted or rewritten. `depinder cache import
 * <dir>` does the same for any folder into the global database.
 */

export const DB_FILE_NAME = 'depinder.sqlite'
export const MISS_TTL_HOURS = 24

export function defaultCacheDbFile(): string {
    return process.env.DEPINDER_CACHE_DB || path.join(depinderFolder, 'cache', DB_FILE_NAME)
}

export interface ImportCounts {
    libs: number
    misses: number
}

export interface CacheStats {
    file: string
    libs: number
    misses: number
    bytes: number
}

export class CacheDb {
    readonly file: string
    private readonly db: DatabaseSync

    constructor(file: string) {
        this.file = file
        fs.mkdirSync(path.dirname(file), {recursive: true})
        const fresh = !fs.existsSync(file)
        this.db = new DatabaseSync(file)
        // WAL: readers never block the writer; NORMAL: durable at checkpoint, not per commit,
        // which is what a cache needs and what makes per-row writes cost nothing noticeable.
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS libs (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS misses (
                key TEXT PRIMARY KEY,
                at  INTEGER NOT NULL
            );
        `)
        if (fresh) this.importLegacy(path.dirname(file))
    }

    // --- libs -------------------------------------------------------------------------------

    /**
     * The entry under `key`. With `cutoffMs`, only a fresh one — written at or after the cutoff
     * (see `max-age.ts`); an expired row reads as absent. Without it, any row, whatever its age.
     */
    getLib(key: string, cutoffMs?: number): LibraryInfo | undefined {
        const row = (cutoffMs === undefined
            ? this.db.prepare('SELECT value FROM libs WHERE key = ?').get(key)
            : this.db.prepare('SELECT value FROM libs WHERE key = ? AND updated_at >= ?').get(key, cutoffMs)
        ) as {value: string} | undefined
        return row ? JSON.parse(row.value) as LibraryInfo : undefined
    }

    /** Same freshness rule as `getLib`. */
    hasLib(key: string, cutoffMs?: number): boolean {
        return (cutoffMs === undefined
            ? this.db.prepare('SELECT 1 FROM libs WHERE key = ?').get(key)
            : this.db.prepare('SELECT 1 FROM libs WHERE key = ? AND updated_at >= ?').get(key, cutoffMs)
        ) !== undefined
    }

    /** When the entry under `key` was last written (epoch milliseconds), or `undefined` if there is none. */
    libUpdatedAt(key: string): number | undefined {
        const row = this.db.prepare('SELECT updated_at FROM libs WHERE key = ?').get(key) as {updated_at: number} | undefined
        return row ? Number(row.updated_at) : undefined
    }

    setLib(key: string, value: LibraryInfo): void {
        this.db.prepare('INSERT OR REPLACE INTO libs (key, value, updated_at) VALUES (?, ?, ?)')
            .run(key, JSON.stringify(value), Date.now())
    }

    /** In insertion order (rowid), the order `libs.json` had. */
    libKeys(): string[] {
        return (this.db.prepare('SELECT key FROM libs ORDER BY rowid').all() as {key: string}[]).map(it => it.key)
    }

    /** Keys last written before `ms` (epoch milliseconds), in insertion order: what `update` refreshes. */
    libKeysUpdatedBefore(ms: number): string[] {
        return (this.db.prepare('SELECT key FROM libs WHERE updated_at < ? ORDER BY rowid').all(ms) as {key: string}[]).map(it => it.key)
    }

    /** How many entries were last written before `ms`: the expired ones, at that cutoff. */
    countLibsUpdatedBefore(ms: number): number {
        return Number((this.db.prepare('SELECT count(*) AS n FROM libs WHERE updated_at < ?').get(ms) as {n: number}).n)
    }

    /** Every entry, parsed, in insertion order. A twelve-repository run is ~90 MB of JSON; call it once. */
    libEntries(): [string, LibraryInfo][] {
        return (this.db.prepare('SELECT key, value FROM libs ORDER BY rowid').all() as {key: string, value: string}[])
            .map(it => [it.key, JSON.parse(it.value) as LibraryInfo])
    }

    // --- misses -----------------------------------------------------------------------------

    hasMiss(key: string, now = Date.now()): boolean {
        const row = this.db.prepare('SELECT at FROM misses WHERE key = ?').get(key) as {at: number} | undefined
        return row !== undefined && !expired(row.at, now)
    }

    setMiss(key: string, at = Date.now()): void {
        this.db.prepare('INSERT OR REPLACE INTO misses (key, at) VALUES (?, ?)').run(key, at)
    }

    deleteMiss(key: string): void {
        this.db.prepare('DELETE FROM misses WHERE key = ?').run(key)
    }

    /** Live keys only: an expired miss is not a miss any more. */
    missKeys(now = Date.now()): string[] {
        return (this.db.prepare('SELECT key FROM misses WHERE at > ? ORDER BY key').all(now - MISS_TTL_HOURS * 3600_000) as {key: string}[])
            .map(it => it.key)
    }

    pruneMisses(now = Date.now()): number {
        return Number(this.db.prepare('DELETE FROM misses WHERE at <= ?').run(now - MISS_TTL_HOURS * 3600_000).changes)
    }

    // --- whole-database operations ----------------------------------------------------------

    /** Runs `fn` in one transaction: a bulk import of 5,000 rows is one fsync, not 5,000. */
    transaction<T>(fn: () => T): T {
        this.db.exec('BEGIN')
        try {
            const result = fn()
            this.db.exec('COMMIT')
            return result
        } catch (e) {
            this.db.exec('ROLLBACK')
            throw e
        }
    }

    /**
     * Imports the JSON files of the previous cache layout from `dir`, if any: `libs.json` and
     * `misses.json`. A row already in the database is kept — an import never overwrites an entry
     * a later run already refreshed. The files are left as they are.
     *
     * An imported library's age is the age of the file it came from: `updated_at` is `libs.json`'s
     * mtime. A file older than the cache max age therefore imports as expired, and the next
     * analyse asks for those libraries again; a recent one stays fresh for what is left of its
     * window. Misses keep the timestamps `misses.json` recorded.
     */
    importLegacy(dir: string): ImportCounts {
        const counts: ImportCounts = {libs: 0, misses: 0}
        const libsFile = path.join(dir, 'libs.json')
        const missesFile = path.join(dir, 'misses.json')
        if (!fs.existsSync(libsFile) && !fs.existsSync(missesFile)) return counts
        this.transaction(() => {
            if (fs.existsSync(libsFile)) {
                const at = Math.round(fs.statSync(libsFile).mtimeMs)
                const insert = this.db.prepare('INSERT OR IGNORE INTO libs (key, value, updated_at) VALUES (?, ?, ?)')
                for (const [key, value] of Object.entries(readJson(libsFile))) {
                    counts.libs += Number(insert.run(key, JSON.stringify(value), at).changes)
                }
            }
            if (fs.existsSync(missesFile)) {
                const insert = this.db.prepare('INSERT OR IGNORE INTO misses (key, at) VALUES (?, ?)')
                for (const [key, at] of Object.entries(readJson(missesFile))) {
                    if (typeof at === 'number') counts.misses += Number(insert.run(key, at).changes)
                }
            }
        })
        return counts
    }

    stats(): CacheStats {
        const count = (table: string) => Number((this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}).n)
        return {
            file: this.file,
            libs: count('libs'),
            misses: count('misses'),
            bytes: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
        }
    }

    close(): void {
        this.db.close()
    }
}

function expired(at: number, now: number): boolean {
    return now - at > MISS_TTL_HOURS * 3600_000
}

function readJson(file: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (e) {
        // An unreadable legacy file costs a few repeated lookups, not the run.
        return {}
    }
}

export function openCacheDb(file: string = defaultCacheDbFile()): CacheDb {
    return new CacheDb(file)
}

// --- the process-wide instance the commands use ---------------------------------------------

let shared: CacheDb | undefined

/** The database at `defaultCacheDbFile()`, opened once per process. */
export function sharedCacheDb(): CacheDb {
    if (!shared) shared = openCacheDb()
    return shared
}

/** For tests: closes the shared database so the next call re-reads `DEPINDER_CACHE_DB`. */
export function resetSharedCacheDb(): void {
    shared?.close()
    shared = undefined
}

/**
 * The `Cache` an analyse run uses: it sees only entries written at or after `cutoffMs`, so an
 * expired entry reads as missing and is fetched again. `set` stamps `updated_at` with the current
 * time, so whatever the run writes is fresh for the rest of it. Every `set` is durable on its own.
 */
export function sqliteCacheWithCutoff(cutoffMs: number | undefined): Cache {
    return {
        get(key: string): LibraryInfo | undefined {
            return sharedCacheDb().getLib(key, cutoffMs)
        },
        set(key: string, value: LibraryInfo): void {
            sharedCacheDb().setLib(key, value)
        },
        has(key: string): boolean {
            return sharedCacheDb().hasLib(key, cutoffMs)
        },
        isExpired(key: string): boolean {
            if (cutoffMs === undefined) return false
            const updatedAt = sharedCacheDb().libUpdatedAt(key)
            return updatedAt !== undefined && updatedAt < cutoffMs
        },
        load() {
            sharedCacheDb()
        },
        // Each row is committed when it is set, so a checkpoint has nothing left to make durable.
        flush() {
            // durable already
        },
        write() {
            // durable already; the connection stays open for the process
        },
    }
}

/** The cache with no age limit: every row, however old. What `update` reads and writes through. */
export const sqliteCache: Cache = sqliteCacheWithCutoff(undefined)
