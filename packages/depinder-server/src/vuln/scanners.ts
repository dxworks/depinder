import {spawn} from 'node:child_process'
import {readdir, rm} from 'node:fs/promises'
import {join} from 'node:path'
import type {VulnConfig} from './config.js'
import type {GrypeReport, TrivyReport} from './merge/index.js'

/**
 * Running Trivy and Grype as child processes.
 *
 * Both are spawned directly, never through a shell, so nothing in a path or a purl is ever
 * interpreted. Each run has a deadline and can be cut short by the request that asked for it; in
 * both cases the child is sent `SIGKILL`, because a scanner busy matching ten thousand packages has
 * nothing worth flushing and a polite `SIGTERM` would only keep a slot occupied.
 */

export type ScannerName = 'trivy' | 'grype'

/** Scanner JSON for 5 000 purls is ~4 MB (Trivy) and ~2.5 MB (Grype); this is a runaway, not a size. */
const MAX_SCANNER_OUTPUT_BYTES = 512 * 1024 * 1024
/** Enough of stderr to hold a scanner's verdict, however much it logged before it. */
const STDERR_TAIL_BYTES = 64 * 1024
/** `--version`, `version` and `db status` answer in well under a second; this is a hang. */
const PROBE_TIMEOUT_MS = 30_000

/** Each scan's temp folder starts with this, so a crashed process's leftovers can be found. */
export const SCAN_DIR_PREFIX = 'depinder-vuln-'

export class ScanError extends Error {
    constructor(
        readonly scanner: ScannerName,
        /** `timeout`, `aborted`, `exit <code> — <verdict>`, `spawn failed: <msg>`, `output too large`, `unparseable output`. */
        readonly reason: string,
        readonly exitCode?: number,
        /** The last 64 KB of stderr, for the log. Never sent to the caller. */
        readonly stderrTail = '',
    ) {
        super(`${scanner}: ${reason}`)
    }
}

interface RunOptions {
    timeoutMs: number
    /** The caller's signal: the request went away, or the other scanner of the pair failed. */
    signal?: AbortSignal
    maxBytes?: number
}

/**
 * Runs one scanner to completion and returns its stdout. Throws `ScanError` for anything but a
 * zero exit: a timeout, an abort, a missing binary, too much output, or a non-zero exit, whose
 * reason carries the scanner's own verdict line from stderr.
 */
export function runScanner(
    tool: ScannerName,
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options: RunOptions,
): Promise<{stdout: string}> {
    const maxBytes = options.maxBytes ?? MAX_SCANNER_OUTPUT_BYTES
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
            reject(new ScanError(tool, 'aborted'))
            return
        }

        const child = spawn(bin, args, {env, stdio: ['ignore', 'pipe', 'pipe'], shell: false})
        const stdout: Buffer[] = []
        let stdoutBytes = 0
        let stderr = Buffer.alloc(0)
        // Why we killed it, if we did. Decides the reason when the child exits on our SIGKILL.
        let killedFor: string | undefined
        let settled = false

        const kill = (reason: string): void => {
            if (killedFor || child.exitCode !== null || child.signalCode !== null) return
            killedFor = reason
            child.kill('SIGKILL')
        }
        const onAbort = (): void => kill('aborted')
        const timer = setTimeout(() => kill('timeout'), options.timeoutMs)
        options.signal?.addEventListener('abort', onAbort, {once: true})

        const settle = (error: ScanError | undefined): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
            if (error) reject(error)
            else resolve({stdout: Buffer.concat(stdout, stdoutBytes).toString('utf8')})
        }

        child.stdout.on('data', (chunk: Buffer) => {
            if (killedFor) return
            stdoutBytes += chunk.length
            if (stdoutBytes > maxBytes) {
                kill('output too large')
                return
            }
            stdout.push(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
            stderr = Buffer.concat([stderr, chunk])
            if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(stderr.length - STDERR_TAIL_BYTES)
        })

        // A binary that is not there fails here, before it ever runs; `close` may not follow.
        child.on('error', e => {
            settle(new ScanError(tool, `spawn failed: ${e.message}`, undefined, stderr.toString('utf8')))
        })
        // `close` rather than `exit`: it waits for stdout to be drained, so the JSON is whole.
        child.on('close', (code, signal) => {
            const tail = stderr.toString('utf8')
            if (killedFor) {
                settle(new ScanError(tool, killedFor, code ?? undefined, tail))
            } else if (code === 0) {
                settle(undefined)
            } else {
                const head = code !== null ? `exit ${code}` : `exit ${signal ?? 'unknown'}`
                settle(new ScanError(tool, scannerFailureReason({message: head, stderr: tail}), code ?? undefined, tail))
            }
        })
    })
}

/**
 * Why a scanner call failed, in one line, with the scanner's own last word kept.
 *
 * Ported from depinder's `local-scan.ts`. The head alone (`exit 1`) names the failure and never
 * the reason — an expired database the scanner could not re-download reads exactly like a corrupt
 * SBOM. The last stderr line that mentions a failure is the one the scanner meant as its verdict.
 * Grype colours its log lines; the escapes are dropped so the reason reads as text.
 */
function scannerFailureReason(e: {message?: string, stderr?: string}): string {
    const head = `${e.message ?? ''}`.split('\n')[0] ?? ''
    const lines = `${e.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(it => it.trim()).filter(Boolean)
    const detail = [...lines].reverse().find(it => /error|fatal|failed|denied/i.test(it)) ?? lines[lines.length - 1]
    return detail ? `${head} — ${detail}` : head
}

export interface ScanReports {
    trivy: TrivyReport
    grype: GrypeReport
    trivyMs: number
    grypeMs: number
}

/** The folders a scan reads, from its lease: Trivy's `--cache-dir`, Grype's `GRYPE_DB_CACHE_DIR`. */
export interface ScanDirs {
    trivy: string
    grype: string
}

type ScanConfig = Pick<VulnConfig, 'trivyBin' | 'grypeBin' | 'scanTimeoutMs'>

/**
 * Trivy over one SBOM, against the database in `dir`. This is Phase 0's command and flags exactly —
 * the ones whose findings matched scanning the real SBOMs — so a flag is not added here without
 * re-running `bench/micro/vuln-parity.ts`. `--skip-db-update`: the scan only ever reads its database.
 */
export async function scanTrivy(sbomPath: string, dir: string, config: ScanConfig, signal?: AbortSignal): Promise<TrivyReport> {
    const {stdout} = await runScanner('trivy', config.trivyBin,
        ['sbom', '--quiet', '--format', 'json', '--skip-db-update', '--cache-dir', dir, sbomPath],
        process.env, {timeoutMs: config.scanTimeoutMs, signal})
    return parseReport('trivy', stdout, isTrivyReport)
}

/** Grype over one SBOM, against the database in `dir`: Phase 0's command, with `grypeEnv`. */
export async function scanGrype(sbomPath: string, dir: string, config: ScanConfig, signal?: AbortSignal): Promise<GrypeReport> {
    const {stdout} = await runScanner('grype', config.grypeBin, ['-q', `sbom:${sbomPath}`, '-o', 'json'], grypeEnv(dir), {
        timeoutMs: config.scanTimeoutMs,
        signal,
    })
    return parseReport('grype', stdout, isGrypeReport)
}

/**
 * Both scanners over one SBOM, side by side, each against the folder its lease names.
 *
 * If one fails, the other is aborted (half an answer is no answer) and the first failure is the
 * one thrown. Both children are gone when this returns, so the caller can remove the SBOM and let
 * go of the lease.
 */
export async function scanBoth(sbomPath: string, dirs: ScanDirs, config: ScanConfig, signal?: AbortSignal): Promise<ScanReports> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', onAbort, {once: true})

    let first: unknown
    const timed = async <T>(scan: () => Promise<T>) => {
        const started = Date.now()
        try {
            return {report: await scan(), ms: Date.now() - started}
        } catch (e) {
            first ??= e
            controller.abort()
            throw e
        }
    }

    try {
        const [trivy, grype] = await Promise.allSettled([
            timed(() => scanTrivy(sbomPath, dirs.trivy, config, controller.signal)),
            timed(() => scanGrype(sbomPath, dirs.grype, config, controller.signal)),
        ])
        if (trivy.status === 'rejected' || grype.status === 'rejected') throw first
        return {trivy: trivy.value.report, grype: grype.value.report, trivyMs: trivy.value.ms, grypeMs: grype.value.ms}
    } finally {
        signal?.removeEventListener('abort', onAbort)
    }
}

function parseReport<T>(tool: ScannerName, stdout: string, check: (report: unknown) => report is T): T {
    let report: unknown
    try {
        report = JSON.parse(stdout)
    } catch {
        throw new ScanError(tool, 'unparseable output')
    }
    if (!check(report)) throw new ScanError(tool, 'unparseable output')
    return report
}

/** An object whose `Results`, if any, is an array. Trivy leaves `Results` out when nothing matched. */
function isTrivyReport(report: unknown): report is TrivyReport {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return false
    const results = (report as {Results?: unknown}).Results
    return results === undefined || Array.isArray(results)
}

/** An object with a `matches` array, empty when nothing matched. */
function isGrypeReport(report: unknown): report is GrypeReport {
    if (!report || typeof report !== 'object' || Array.isArray(report)) return false
    return Array.isArray((report as {matches?: unknown}).matches)
}

/**
 * The environment every Grype call runs with. Grype would otherwise refresh its database inside
 * the scan, refuse a database it thinks too old, and phone home for a newer release. A scan only
 * ever reads its database; new builds arrive through `grype db update` into a folder of their own.
 * Without a folder (`grype version`), Grype's own default is left alone: nothing reads it.
 */
export function grypeEnv(dir?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GRYPE_DB_AUTO_UPDATE: 'false',
        GRYPE_DB_VALIDATE_AGE: 'false',
        GRYPE_CHECK_FOR_APP_UPDATE: 'false',
    }
    if (dir) env.GRYPE_DB_CACHE_DIR = dir
    return env
}

/**
 * Downloads the Trivy database from `TRIVY_DB_REPOSITORY` into the empty `stagingDir`, which ends
 * up holding `db/trivy.db` and `db/metadata.json` and nothing else (checked with Trivy 0.74). The
 * same repository our check read, so the two never disagree about where builds come from.
 * `--skip-version-check`: no call home for Trivy's own release notices.
 */
export async function downloadTrivyDb(
    stagingDir: string,
    config: Pick<VulnConfig, 'trivyBin' | 'trivyDbRepository' | 'downloadTimeoutMs'>,
    signal?: AbortSignal,
): Promise<void> {
    await runScanner('trivy', config.trivyBin, [
        'image', '--download-db-only', '--db-repository', config.trivyDbRepository,
        '--cache-dir', stagingDir, '--quiet', '--skip-version-check',
    ], process.env, {timeoutMs: config.downloadTimeoutMs, signal})
}

/**
 * Downloads the Grype database named by `GRYPE_DB_UPDATE_URL` into the empty `stagingDir`, which
 * ends up holding `6/vulnerability.db`, `6/import.json` and `6/last_update_check` (Grype 0.118).
 * Most of its minute is spent decompressing, not downloading.
 */
export async function downloadGrypeDb(
    stagingDir: string,
    config: Pick<VulnConfig, 'grypeBin' | 'grypeDbUpdateUrl' | 'downloadTimeoutMs'>,
    signal?: AbortSignal,
): Promise<void> {
    await runScanner('grype', config.grypeBin, ['db', 'update'], {
        ...grypeEnv(stagingDir),
        GRYPE_DB_UPDATE_URL: config.grypeDbUpdateUrl,
    }, {timeoutMs: config.downloadTimeoutMs, signal})
}

export interface ScannerVersions {
    trivy: string
    grype: string
}

/**
 * The two scanners' versions, read once at startup. A binary that is missing or cannot say its
 * version is a deployment mistake, not a runtime condition, so this throws with a message that
 * names the setting to fix and the process exits.
 */
export async function scannerVersions(config: Pick<VulnConfig, 'trivyBin' | 'grypeBin'>): Promise<ScannerVersions> {
    const probe = async (tool: ScannerName, bin: string, args: string[], env: NodeJS.ProcessEnv, field: string) => {
        let stdout: string
        try {
            ;({stdout} = await runScanner(tool, bin, args, env, {timeoutMs: PROBE_TIMEOUT_MS}))
        } catch (e) {
            const reason = e instanceof ScanError ? e.reason : String(e)
            if (reason.includes('ENOENT')) {
                throw new Error(`binary '${bin}' not found — set ${tool.toUpperCase()}_BIN`)
            }
            throw new Error(`'${bin} ${args.join(' ')}' failed: ${reason}`)
        }
        let version: unknown
        try {
            version = (JSON.parse(stdout) as Record<string, unknown>)[field]
        } catch {
            version = undefined
        }
        if (typeof version !== 'string' || !version) {
            throw new Error(`'${bin} ${args.join(' ')}' did not report a version — is ${tool.toUpperCase()}_BIN really ${tool}?`)
        }
        return version
    }
    const [trivy, grype] = await Promise.all([
        probe('trivy', config.trivyBin, ['--version', '--format', 'json'], process.env, 'Version'),
        probe('grype', config.grypeBin, ['version', '-o', 'json'], grypeEnv(), 'version'),
    ])
    return {trivy, grype}
}

/**
 * Removes the `depinder-vuln-*` folders a crashed earlier process left behind. Every scan removes
 * its own in a `finally`, so on a clean run there is nothing here to find.
 */
export async function removeLeftoverScanDirs(tmpDir: string): Promise<number> {
    let names: string[]
    try {
        names = await readdir(tmpDir)
    } catch {
        return 0
    }
    const leftovers = names.filter(name => name.startsWith(SCAN_DIR_PREFIX))
    await Promise.all(leftovers.map(name => rm(join(tmpDir, name), {recursive: true, force: true})))
    return leftovers.length
}
