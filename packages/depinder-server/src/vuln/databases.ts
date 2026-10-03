import {readFile, stat} from 'node:fs/promises'
import {join} from 'node:path'
import {errorMessage} from '../shared/log.js'
import type {VulnConfig} from './config.js'
import {grypeEnv, runScanner, ScanError} from './scanners.js'

/**
 * Which build a database folder holds, and, for frozen mode, whether the two folders are there at
 * all.
 *
 * In frozen mode the databases are put on disk by someone else and this only looks. Each call to
 * `current()` costs three `stat`s: a ready answer is cached against the size and mtime of the three
 * files that make up the two databases, and read again only when one of them changed — so a
 * database swapped in place is picked up by the next request, with no restart.
 *
 * Managed mode reads a freshly downloaded folder with the same two readers, `readTrivyBuild` and
 * `readGrypeBuild`, so a build is described the same way whichever mode put it there.
 */

export interface DatabaseBuild {
    /** When the database was built upstream: Trivy's `UpdatedAt`, Grype's `built`. */
    built_at: string
    /** Trivy's schema `Version` (`2`), Grype's `schemaVersion` (`v6.1.9`). */
    schema: string
}

export type DbState =
    | {ready: true, trivy: DatabaseBuild, grype: DatabaseBuild}
    | {ready: false, reason: string}

export interface DatabaseInfo {
    current(): Promise<DbState>
}

/** Grype's status command over one folder, overridable in tests. Returns its stdout. */
type GrypeStatus = (dir: string, signal?: AbortSignal) => Promise<string>

/** A database folder whose build cannot be told. `message` is the reason, for logs and 503s. */
class DatabaseError extends Error {}

/** `db status` answers in about 0.4 s; this is a hang. */
const STATUS_TIMEOUT_MS = 30_000

/** The real `grype db status -o json`, with `grypeEnv` pointing it at `dir`. */
export function grypeStatusCommand(grypeBin: string): GrypeStatus {
    return async (dir, signal) => {
        const {stdout} = await runScanner('grype', grypeBin, ['db', 'status', '-o', 'json'], grypeEnv(dir), {
            timeoutMs: STATUS_TIMEOUT_MS,
            signal,
        })
        return stdout
    }
}

/** Trivy's build, from `<cacheDir>/db/metadata.json`. Throws `DatabaseError`. */
export async function readTrivyBuild(cacheDir: string): Promise<DatabaseBuild> {
    const path = join(cacheDir, 'db', 'metadata.json')
    let meta: {Version?: unknown, UpdatedAt?: unknown}
    try {
        meta = JSON.parse(await readFile(path, 'utf8')) as typeof meta
    } catch (e) {
        throw new DatabaseError(`trivy metadata unreadable: ${errorMessage(e)}`)
    }
    if (typeof meta.UpdatedAt !== 'string' || meta.Version === undefined) {
        throw new DatabaseError(`${path} has no UpdatedAt or Version`)
    }
    return {built_at: meta.UpdatedAt, schema: String(meta.Version)}
}

/** Grype's build, from `db status` over `cacheDir`. Throws `DatabaseError`. */
export async function readGrypeBuild(cacheDir: string, status: GrypeStatus, signal?: AbortSignal): Promise<DatabaseBuild> {
    let report: {built?: unknown, schemaVersion?: unknown, valid?: unknown, error?: unknown}
    try {
        report = JSON.parse(await status(cacheDir, signal)) as typeof report
    } catch (e) {
        throw new DatabaseError(`grype db status failed: ${e instanceof ScanError ? e.reason : errorMessage(e)}`)
    }
    if (report.valid !== true) {
        throw new DatabaseError(`grype database not valid: ${typeof report.error === 'string' ? report.error : 'no reason given'}`)
    }
    if (typeof report.built !== 'string' || typeof report.schemaVersion !== 'string') {
        throw new DatabaseError('grype db status has no built or schemaVersion')
    }
    return {built_at: report.built, schema: report.schemaVersion}
}

/** Frozen mode's two folders. */
export function createDatabaseInfo(
    config: {trivyCacheDir: string, grypeDbCacheDir: string} & Pick<VulnConfig, 'grypeBin'>,
    grypeStatus?: GrypeStatus,
): DatabaseInfo {
    const trivyDb = join(config.trivyCacheDir, 'db', 'trivy.db')
    const trivyMeta = join(config.trivyCacheDir, 'db', 'metadata.json')
    const grypeDb = join(config.grypeDbCacheDir, '6', 'vulnerability.db')
    const status = grypeStatus ?? grypeStatusCommand(config.grypeBin)

    let cached: {key: string, state: DbState} | undefined
    // One refresh at a time, shared by everyone who asks while it runs.
    let refreshing: {key: string, promise: Promise<DbState>} | undefined

    const read = async (): Promise<DbState> => {
        try {
            const trivy = await readTrivyBuild(config.trivyCacheDir)
            const grype = await readGrypeBuild(config.grypeDbCacheDir, status)
            return {ready: true, trivy, grype}
        } catch (e) {
            return {ready: false, reason: errorMessage(e)}
        }
    }

    return {
        async current() {
            const stats = await Promise.all([trivyDb, trivyMeta, grypeDb].map(path => stat(path).catch(() => undefined)))
            const missing = [trivyDb, trivyMeta, grypeDb].filter((_, i) => !stats[i])
            if (missing.length > 0) return {ready: false, reason: `missing ${missing.join(', ')}`}

            const key = stats.map(s => `${s!.mtimeMs}:${s!.size}`).join('|')
            if (cached?.key === key) return cached.state
            if (refreshing?.key === key) return refreshing.promise
            const promise = read().then(state => {
                // Only a good answer is kept. A `db status` that failed on files that look fine
                // (a timeout, a half-copied database) is asked again next time, not served until
                // the files happen to change.
                if (state.ready) cached = {key, state}
                return state
            }).finally(() => {
                if (refreshing?.promise === promise) refreshing = undefined
            })
            refreshing = {key, promise}
            return promise
        },
    }
}
