import {DatabaseSync} from 'node:sqlite'

/** What the compare reads back from a run's kept SQLite cache (`--keep-caches`): depinder's `LibraryInfo`. */
interface CachedLibrary {
    versions?: {version?: string, timestamp?: number}[]
    reposUrl?: string[]
}

/** B's kept cache, one lookup per library. */
export class KeptCache {
    private readonly db: DatabaseSync
    private readonly memo = new Map<string, CachedLibrary | null>()

    constructor(cacheFile: string, private readonly cutoffMs: number) {
        this.db = new DatabaseSync(cacheFile, {readOnly: true})
    }

    /** Whether any version of the library was published after the cutoff (A's start). */
    hasReleaseAfterCutoff(ecosystems: readonly string[], name: string): boolean {
        return ecosystems.some(eco => (this.library(eco, name)?.versions ?? []).some(v => (v.timestamp ?? 0) > this.cutoffMs))
    }

    /** Whether this version of the library was published after the cutoff (A's start). */
    isReleasedAfterCutoff(ecosystems: readonly string[], name: string, version: string): boolean {
        return ecosystems.some(eco => (this.library(eco, name)?.versions ?? [])
            .some(v => v.version === version && (v.timestamp ?? 0) > this.cutoffMs))
    }

    /** The registry's top-level repository, as the resolver served it; '' when it has none. */
    repositoryOf(ecosystem: string, name: string): string | undefined {
        const library = this.library(ecosystem, name)
        return library ? library.reposUrl?.[0] ?? '' : undefined
    }

    private library(ecosystem: string, name: string): CachedLibrary | null {
        const memoKey = `${ecosystem}|${name}`
        if (!this.memo.has(memoKey)) {
            const found = [name, name.toLowerCase()].map(n => this.read(`${ecosystem}:${n}`)).find(Boolean) ?? null
            this.memo.set(memoKey, found)
        }
        return this.memo.get(memoKey) ?? null
    }

    private read(key: string): CachedLibrary | null {
        const row = this.db.prepare('SELECT value FROM libs WHERE key = ?').get(key) as {value: string} | undefined
        return row ? JSON.parse(row.value) as CachedLibrary : null
    }

    close(): void {
        this.db.close()
    }
}
