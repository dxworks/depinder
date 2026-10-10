import {execFile} from 'child_process'
import {promisify} from 'util'
import {PINNED_SCANNER_VERSIONS} from '@depinder/core'
import {vulnSources} from '../../vuln-sources/selection'
import {log} from '../../utils/logging'
import {timePhase} from '../../utils/profile'

/**
 * Which local scanners exist, at which version and DB build, probed ONCE per process so the user is
 * told before the run rather than in a warning buried mid-log; plus the one DB refresh every scan
 * awaits. The statuses probed here are what `scan-provenance.ts` records.
 */

const execFileAsync = promisify(execFile)

/** Scanner JSON can be tens of MB (Grype on Zeppelin: ~3,700 matches). */
export const MAX_SCANNER_OUTPUT_BYTES = 1024 * 1024 * 1024

type ScannerName = 'trivy' | 'grype'

/** What one scanner is, as observed on this machine — the unit of both messaging and provenance. */
export interface ScannerStatus {
    tool: ScannerName
    /** The resolved binary: TRIVY_BIN/GRYPE_BIN if set, else the bare name looked up on PATH. */
    bin: string
    installed: boolean
    version?: string
    pinnedVersion: string
    /** False also when the version could not be read at all — unknown is not "as pinned". */
    versionMatchesPin: boolean
    /** Trivy: DB schema version. Grype: DB schema version (e.g. `v6.1.9`). */
    dbVersion?: string
    /** Trivy: `VulnerabilityDB.UpdatedAt`. Grype: `built` from `grype db status`. */
    dbBuiltAt?: string
    /** Why the probe failed, when it did — the text the user is shown to fix it. */
    error?: string
}

export interface ScannerPreflight {
    trivy: ScannerStatus
    grype: ScannerStatus
    /** 2 = full coverage, 1 = partial, 0 = no local scanning at all. */
    installedCount: number
}

function scannerBin(tool: ScannerName): string {
    return (tool === 'trivy' ? process.env.TRIVY_BIN : process.env.GRYPE_BIN) || tool
}

/** A short, actionable reason — this text ends up in front of the user, not just in the log. */
function probeFailure(tool: ScannerName, bin: string, e: any): string {
    if (e?.code === 'ENOENT') {
        const envVar = `${tool.toUpperCase()}_BIN`
        return `binary '${bin}' not found — install ${tool}, or set ${envVar} to its full path`
    }
    return `${e?.message ?? e}`.split('\n')[0]
}

async function probeTrivy(): Promise<ScannerStatus> {
    const bin = scannerBin('trivy')
    const status: ScannerStatus = {
        tool: 'trivy', bin, installed: false, pinnedVersion: PINNED_SCANNER_VERSIONS.trivy,
        versionMatchesPin: false,
    }
    try {
        const {stdout} = await execFileAsync(bin, ['--version', '--format', 'json'])
        status.installed = true
        // A stub or an older CLI may not honour `--format json`; the binary still exists and can
        // still scan, so a version we cannot read degrades to "unknown", not to "missing".
        const report = JSON.parse(stdout) as TrivyVersionReport
        status.version = report.Version
        setTrivyDb(status, report)
    } catch (e: any) {
        if (!status.installed) status.error = probeFailure('trivy', bin, e)
    }
    status.versionMatchesPin = status.version === status.pinnedVersion
    return status
}

type TrivyVersionReport = {Version?: string, VulnerabilityDB?: {Version?: number, UpdatedAt?: string}}

function setTrivyDb(status: ScannerStatus, report: TrivyVersionReport): void {
    status.dbVersion = report.VulnerabilityDB?.Version !== undefined ? String(report.VulnerabilityDB.Version) : undefined
    status.dbBuiltAt = report.VulnerabilityDB?.UpdatedAt
}

/** Grype keeps the DB build date in a separate command from its version. */
async function readGrypeDb(status: ScannerStatus): Promise<void> {
    const {stdout} = await execFileAsync(status.bin, ['db', 'status', '-o', 'json'])
    const db = JSON.parse(stdout) as {schemaVersion?: string, built?: string}
    status.dbVersion = db.schemaVersion
    status.dbBuiltAt = db.built
}

/**
 * Reads a scanner's DB build again, after `warmScannerDatabases` refreshed it: the preflight probed
 * the build that was on disk BEFORE the refresh, and provenance must name the build the scans
 * actually read. A failed re-read keeps what the preflight saw.
 */
async function rereadDb(status: ScannerStatus): Promise<void> {
    try {
        if (status.tool === 'trivy') {
            const {stdout} = await execFileAsync(status.bin, ['--version', '--format', 'json'])
            setTrivyDb(status, JSON.parse(stdout) as TrivyVersionReport)
        } else {
            await readGrypeDb(status)
        }
    } catch {
        // Left as the preflight recorded it.
    }
}

async function probeGrype(): Promise<ScannerStatus> {
    const bin = scannerBin('grype')
    const status: ScannerStatus = {
        tool: 'grype', bin, installed: false, pinnedVersion: PINNED_SCANNER_VERSIONS.grype,
        versionMatchesPin: false,
    }
    try {
        const {stdout} = await execFileAsync(bin, ['version', '-o', 'json'])
        status.installed = true
        status.version = (JSON.parse(stdout) as {version?: string}).version
    } catch (e: any) {
        if (!status.installed) status.error = probeFailure('grype', bin, e)
    }
    if (status.installed) {
        // Grype keeps the DB build date in a separate command; a missing DB must not read as a
        // missing scanner, since grype downloads it on first scan.
        try {
            await readGrypeDb(status)
        } catch {
            // Left undefined — reported as "DB unknown" rather than treated as an error.
        }
    }
    status.versionMatchesPin = status.version === status.pinnedVersion
    return status
}

let preflightPromise: Promise<ScannerPreflight> | undefined

/** Probes both scanners once per process. Never throws — a broken probe is a reported state. */
export function preflightScanners(): Promise<ScannerPreflight> {
    if (!preflightPromise) {
        preflightPromise = (async () => {
            const [trivy, grype] = await Promise.all([probeTrivy(), probeGrype()])
            return {trivy, grype, installedCount: (trivy.installed ? 1 : 0) + (grype.installed ? 1 : 0)}
        })()
    }
    return preflightPromise
}

/**
 * Why a scanner call failed, in one line, with the scanner's own last word kept.
 *
 * `execFile` rejects with `Command failed: trivy sbom --format json <file>` on its first line and
 * the child's stderr under it. Reporting only that first line named the command and never the
 * reason — an expired database the scanner could not re-download reads exactly like a corrupt
 * SBOM. The last stderr line that mentions a failure is the one the scanner meant as its verdict.
 */
export function scannerFailureReason(e: any): string {
    const head = `${e?.message ?? e}`.split('\n')[0]
    const lines = `${e?.stderr ?? ''}`.split('\n').map((it: string) => it.trim()).filter(Boolean)
    const detail = [...lines].reverse().find((it: string) => /error|fatal|failed|denied/i.test(it))
        ?? lines[lines.length - 1]
    return detail ? `${head} — ${detail}` : head
}

let warmPromise: Promise<void> | undefined

/**
 * Refreshes each scanner's vulnerability database once, before the first scan reads it.
 *
 * Both scanners update their DB lazily, inside the scan. With every SBOM scanned at once, an
 * expired DB meant a dozen child processes fetching the same archive simultaneously and all of
 * them failing: the run finished with empty vulnerability columns and one `Command failed` line
 * per file. Every scan awaits this single promise instead, so at most one download happens. A
 * current DB makes it a no-op — `trivy image --download-db-only` and `grype db update` both
 * return in milliseconds when there is nothing to fetch.
 */
export function warmScannerDatabases(): Promise<void> {
    if (!warmPromise) {
        warmPromise = (async () => {
            const preflight = await preflightScanners()
            const selected = vulnSources()
            const jobs: {tool: 'trivy' | 'grype', status: ScannerStatus, args: string[]}[] = [
                {tool: 'trivy', status: preflight.trivy, args: ['image', '--download-db-only']},
                {tool: 'grype', status: preflight.grype, args: ['db', 'update']},
            ]
            // The two databases are unrelated, so the tools refresh side by side; the race this
            // fixes is several processes of the SAME tool fetching the SAME archive.
            await Promise.all(jobs.filter(it => it.status.installed && selected[it.tool]).map(async ({tool, status, args}) => {
                const started = Date.now()
                try {
                    await timePhase(`db:${tool}`, () =>
                        execFileAsync(status.bin, args, {maxBuffer: MAX_SCANNER_OUTPUT_BYTES}))
                    const elapsed = (Date.now() - started) / 1000
                    // Worth a line only when it actually fetched something; a no-op stays silent.
                    if (elapsed > 2) log.info(`${tool} vulnerability DB refreshed in ${elapsed.toFixed(1)}s`)
                    // The preflight's status object is what provenance writes, so it is updated in
                    // place. One extra process per tool: whether the refresh fetched anything is
                    // not something either tool reports reliably.
                    await rereadDb(status)
                } catch (e: any) {
                    log.warn(`${tool} vulnerability DB refresh failed: ${scannerFailureReason(e)}`)
                    log.warn(`  ${tool} scans continue against whatever database is already on disk`)
                }
            }))
        })()
    }
    return warmPromise
}

/** Forgets the probed statuses and the DB refresh; part of `clearLocalScanCache`. */
export function resetScannerPreflight(): void {
    preflightPromise = undefined
    warmPromise = undefined
}
