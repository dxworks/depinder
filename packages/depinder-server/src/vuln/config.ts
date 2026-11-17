import {availableParallelism, tmpdir} from 'node:os'
import {ConfigError, int, requireLogLevel, requirePort, requireToken, str} from '../shared/config.js'
import {VULN_DEFAULT_MAX_PURLS, type LogLevel} from '@depinder/core'
import {normalizeRepository} from './upstream.js'

/** Trivy's own default since 0.6x: Google's mirror, because anonymous pulls from ghcr are rate-limited. */
const DEFAULT_TRIVY_DB_REPOSITORY = 'mirror.gcr.io/aquasec/trivy-db:2'
/** What `grype db update` reads by default for schema v6. */
const DEFAULT_GRYPE_DB_UPDATE_URL = 'https://grype.anchore.io/databases/v6/latest.json'

/**
 * Config for `ROLE=vuln`, the vulnerability server: purls in, Trivy and Grype findings out.
 *
 * It shares the resolver's token, port and log level and nothing else. There is no Postgres:
 * `DATABASE_URL` is neither read nor required, because everything this process knows is in the two
 * scanners' databases on disk, which the server downloads into `VULN_DATA_DIR` and keeps current.
 */
export interface VulnConfig {
    /** Bearer token required on every route except /health. The resolver's, with its checks. */
    apiToken: string
    port: number
    logLevel: LogLevel
    /** The image's scanner, or the one an operator pinned: the baseline the self-update starts from. */
    trivyBin: string
    grypeBin: string
    /** One folder per build, `staging/` and `current.json` (`store.ts`). */
    dataDir: string
    /** Distinct purls one request may carry. Past it the answer is a 413. */
    maxPurls: number
    /** Scans (one Trivy plus one Grype each) running at once. */
    maxScans: number
    /** Requests that may wait for a scan slot. Past it the answer is a 503 busy. */
    maxQueued: number
    /** One scanner run, from spawn to exit, before it is killed. */
    scanTimeoutMs: number
    /** Where each scan's `depinder-vuln-*` folder with the dummy SBOM goes. */
    tmpDir: string
    /** Past this age a Trivy build is reported `stale` (still served). Trivy publishes every ~6 h. */
    trivyStaleHours: number
    /** The same for Grype, which publishes about daily. */
    grypeStaleHours: number
    /** How often each tool asks its publisher for a newer build. */
    checkIntervalMin: number
    /** One download, from spawn to exit, before it is killed. */
    downloadTimeoutMs: number
    /** Where the Trivy build is checked and downloaded from, with its tag (`:2` if none was given). */
    trivyDbRepository: string
    /** Grype's `latest.json`: checked by us, and handed to `grype db update` as `GRYPE_DB_UPDATE_URL`. */
    grypeDbUpdateUrl: string
    /**
     * Per tool: does the server keep its scanner binary current itself (`scanner-updater.ts`).
     * `SCANNER_UPDATE`, default on, and off for a tool whose `TRIVY_BIN`/`GRYPE_BIN` is set: an
     * operator who names a binary has pinned it.
     */
    scannerUpdate: {trivy: boolean, grype: boolean}
    /** How often each tool asks GitHub for a newer release. */
    scannerUpdateIntervalMin: number
    /** A release younger than this is not taken yet: the supply-chain cooldown. */
    scannerMinReleaseAgeDays: number
}

/**
 * Reads the vulnerability server's config. Throws `ConfigError`, like `loadConfig`.
 *
 * `VULN_DATA_DIR` is only checked to be set: the databases are downloaded at runtime, and until
 * they are in the server answers 503 rather than refusing to start.
 */
export function loadVulnConfig(env: NodeJS.ProcessEnv = process.env): VulnConfig {
    const apiToken = requireToken(env)
    const logLevel = requireLogLevel(env)
    const port = requirePort(env)

    const dataDir = str(env.VULN_DATA_DIR)
    if (!dataDir) throw new ConfigError('VULN_DATA_DIR is required (where the server keeps the databases).')

    const rawRepository = str(env.TRIVY_DB_REPOSITORY) ?? DEFAULT_TRIVY_DB_REPOSITORY
    let trivyDbRepository: string
    try {
        trivyDbRepository = normalizeRepository(rawRepository)
    } catch {
        throw new ConfigError(`TRIVY_DB_REPOSITORY must be an OCI repository like ${DEFAULT_TRIVY_DB_REPOSITORY} (got "${rawRepository}").`)
    }
    const grypeDbUpdateUrl = str(env.GRYPE_DB_UPDATE_URL) ?? DEFAULT_GRYPE_DB_UPDATE_URL
    if (!/^https?:\/\/[^/]+/.test(grypeDbUpdateUrl) || !URL.canParse(grypeDbUpdateUrl)) {
        throw new ConfigError(`GRYPE_DB_UPDATE_URL must be an http(s) URL (got "${grypeDbUpdateUrl}").`)
    }

    const scannerUpdate = flag(env, 'SCANNER_UPDATE', true)

    // Half the cores: each scan is two processes, and Grype alone keeps a core busy for most of
    // its run. Inside a container `availableParallelism` can read the host's cores rather than the
    // container's share, which is why docs/vuln-server.md ("Concurrency") says to set this
    // explicitly when deploying.
    const maxScans = int(env, 'VULN_MAX_SCANS', Math.max(1, Math.floor(availableParallelism() / 2)), 1, 64)

    return {
        apiToken,
        port,
        logLevel,
        trivyBin: str(env.TRIVY_BIN) ?? 'trivy',
        grypeBin: str(env.GRYPE_BIN) ?? 'grype',
        dataDir,
        maxPurls: int(env, 'VULN_MAX_PURLS', VULN_DEFAULT_MAX_PURLS, 1, 50_000),
        maxScans,
        maxQueued: int(env, 'VULN_MAX_QUEUED', 4 * maxScans, 0, 1000),
        scanTimeoutMs: int(env, 'VULN_SCAN_TIMEOUT_MS', 60_000, 1000, 600_000),
        tmpDir: str(env.VULN_TMP_DIR) ?? tmpdir(),
        // Four missed Trivy builds; three missed Grype ones.
        trivyStaleHours: int(env, 'VULN_TRIVY_STALE_HOURS', 24, 1, 8760),
        grypeStaleHours: int(env, 'VULN_GRYPE_STALE_HOURS', 72, 1, 8760),
        // 30 min adds ~15 min of average staleness to Trivy's 6-hour cadence, for ~100 tiny
        // requests a day.
        checkIntervalMin: int(env, 'VULN_DB_CHECK_INTERVAL_MIN', 30, 5, 1440),
        // A download is ~5 s (Trivy) and ~1 min (Grype, mostly decompressing) on a good line.
        downloadTimeoutMs: int(env, 'VULN_DB_DOWNLOAD_TIMEOUT_MS', 900_000, 60_000, 7_200_000),
        trivyDbRepository,
        grypeDbUpdateUrl,
        scannerUpdate: {trivy: scannerUpdate && !str(env.TRIVY_BIN), grype: scannerUpdate && !str(env.GRYPE_BIN)},
        // GitHub allows 60 anonymous API reads an hour per address; this is two per interval.
        scannerUpdateIntervalMin: int(env, 'SCANNER_UPDATE_INTERVAL_MIN', 360, 60, 10_080),
        // At least a day: a bad release is usually pulled within days, never within the hour.
        scannerMinReleaseAgeDays: int(env, 'SCANNER_MIN_RELEASE_AGE_DAYS', 7, 1, 365),
    }
}

/** A strict on/off setting: anything but the usual spellings is a mistake, not a default. */
function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
    const raw = str(env[name])
    if (raw === undefined) return fallback
    const value = raw.toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(value)) return true
    if (['0', 'false', 'no', 'off'].includes(value)) return false
    throw new ConfigError(`${name} must be true or false (got "${raw}").`)
}
