import {availableParallelism, tmpdir} from 'node:os'
import {ConfigError, requireLogLevel, requirePort, requireToken, str} from '../shared/config.js'
import type {LogLevel} from '@depinder/core'
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
 * scanners' databases on disk.
 *
 * Two modes, by which folders are set:
 *   managed  `VULN_DATA_DIR`: the server downloads the databases there and keeps them current
 *   frozen   `TRIVY_CACHE_DIR` + `GRYPE_DB_CACHE_DIR`: someone else's folders, read as they are —
 *            what keeps `bench/micro/vuln-parity.ts` and the bench repeatable
 */
export interface VulnConfig {
    mode: 'managed' | 'frozen'
    /** Bearer token required on every route except /health. The resolver's, with its checks. */
    apiToken: string
    port: number
    logLevel: LogLevel
    trivyBin: string
    grypeBin: string
    /** Managed mode: one folder per build, `staging/` and `current.json` (`store.ts`). */
    dataDir?: string
    /** Frozen mode: Trivy's `--cache-dir`, the folder holding `db/trivy.db` and `db/metadata.json`. */
    trivyCacheDir?: string
    /** Frozen mode: Grype's `GRYPE_DB_CACHE_DIR`, the folder holding `6/vulnerability.db`. */
    grypeDbCacheDir?: string
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
    /** Managed mode: how often each tool asks its publisher for a newer build. */
    checkIntervalMin: number
    /** Managed mode: one download, from spawn to exit, before it is killed. */
    downloadTimeoutMs: number
    /** Where the Trivy build is checked and downloaded from, with its tag (`:2` if none was given). */
    trivyDbRepository: string
    /** Grype's `latest.json`: checked by us, and handed to `grype db update` as `GRYPE_DB_UPDATE_URL`. */
    grypeDbUpdateUrl: string
}

/**
 * Reads the vulnerability server's config. Throws `ConfigError`, like `loadConfig`.
 *
 * The folders are only checked to be set: whether the databases are actually in them is a runtime
 * question, because a server that starts before its databases arrive should answer 503 until they
 * do rather than refuse to start.
 */
export function loadVulnConfig(env: NodeJS.ProcessEnv = process.env): VulnConfig {
    const apiToken = requireToken(env)
    const logLevel = requireLogLevel(env)
    const port = requirePort(env)

    const dataDir = str(env.VULN_DATA_DIR)
    const trivyCacheDir = str(env.TRIVY_CACHE_DIR)
    const grypeDbCacheDir = str(env.GRYPE_DB_CACHE_DIR)
    if (dataDir && (trivyCacheDir || grypeDbCacheDir)) {
        throw new ConfigError('Set VULN_DATA_DIR (the server keeps the databases fresh) or TRIVY_CACHE_DIR and '
            + 'GRYPE_DB_CACHE_DIR (frozen folders), not both.')
    }
    if (!dataDir && !trivyCacheDir && !grypeDbCacheDir) {
        throw new ConfigError('VULN_DATA_DIR is required (where the server keeps the databases), '
            + 'or TRIVY_CACHE_DIR and GRYPE_DB_CACHE_DIR for frozen folders.')
    }
    if (!dataDir && !trivyCacheDir) {
        throw new ConfigError('TRIVY_CACHE_DIR is required (the folder with db/trivy.db; Trivy\'s --cache-dir).')
    }
    if (!dataDir && !grypeDbCacheDir) {
        throw new ConfigError('GRYPE_DB_CACHE_DIR is required (the folder with 6/vulnerability.db).')
    }

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

    // Half the cores: each scan is two processes, and Grype alone keeps a core busy for most of
    // its run. Inside a container `availableParallelism` can read the host's cores rather than the
    // container's share, which is why docs/vuln-server.md ("Concurrency") says to set this
    // explicitly when deploying.
    const maxScans = int(env, 'VULN_MAX_SCANS', Math.max(1, Math.floor(availableParallelism() / 2)), 1, 64)

    return {
        mode: dataDir ? 'managed' : 'frozen',
        apiToken,
        port,
        logLevel,
        trivyBin: str(env.TRIVY_BIN) ?? 'trivy',
        grypeBin: str(env.GRYPE_BIN) ?? 'grype',
        ...dataDir ? {dataDir} : {trivyCacheDir, grypeDbCacheDir},
        maxPurls: int(env, 'VULN_MAX_PURLS', 5000, 1, 50_000),
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
    }
}

/** Entry-point wrapper: a readable message on stderr and exit code 1 instead of a stack trace. */
export function loadVulnConfigOrExit(env: NodeJS.ProcessEnv = process.env): VulnConfig {
    try {
        return loadVulnConfig(env)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        process.stderr.write(`depinder-server-side: configuration error\n  ${msg}\n`)
        process.exit(1)
    }
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
    const raw = str(env[name])
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}").`)
    }
    return value
}
