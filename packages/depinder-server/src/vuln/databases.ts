import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {errorMessage} from '@depinder/core'
import {grypeEnv, runScanner, ScanError} from './scanners.js'

/**
 * Which build a database folder holds: `readTrivyBuild` and `readGrypeBuild` read a freshly
 * downloaded folder before it is installed.
 */

export interface DatabaseBuild {
    /** When the database was built upstream: Trivy's `UpdatedAt`, Grype's `built`. */
    built_at: string
    /** Trivy's schema `Version` (`2`), Grype's `schemaVersion` (`v6.1.9`). */
    schema: string
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
