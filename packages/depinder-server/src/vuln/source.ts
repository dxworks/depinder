import type {DatabaseBuild} from './databases.js'
import type {ScannerName} from './scanners.js'

/**
 * Where a scan's databases come from: the builds in the store (`store.ts`), which counts the leases
 * on each.
 *
 * A request leases one Trivy build and one Grype build for its whole scan: both scanners read the
 * builds the answer names, and a build that is replaced meanwhile stays on disk until the last
 * request reading it lets go.
 *
 * `lease()` is synchronous so that nothing can change between the scan slot being granted and the
 * builds being pinned.
 */

export interface BuildInfo extends DatabaseBuild {
    tool: ScannerName
    /** What the scanner is pointed at: Trivy's `--cache-dir`, Grype's `GRYPE_DB_CACHE_DIR`. */
    dir: string
    /** Since `built_at`, at the moment of the lease. */
    age_seconds: number
    /** Older than `VULN_TRIVY_STALE_HOURS` / `VULN_GRYPE_STALE_HOURS`. Served all the same. */
    stale: boolean
}

export interface Lease {
    ready: true
    trivy: BuildInfo
    grype: BuildInfo
    /** Lets go of both builds. Safe to call more than once. */
    release(): void
}

export type LeaseResult = Lease | {ready: false, reason: string}

/** One tool on `/health`: its build, missing while it has none, and what its updater is doing. */
export interface ToolHealth {
    built_at?: string
    schema?: string
    age_seconds?: number
    stale?: boolean
    /** A check or a download is running. */
    updating?: boolean
    last_check_at?: string | null
    /** The last check that ended without an error, whether or not it installed anything. */
    last_ok_at?: string | null
    last_error?: string | null
    next_check_at?: string | null
    /** What the publisher's metadata says its newest build is (Trivy: the manifest's `created`). */
    upstream_built_at?: string | null
}

export interface SourceHealth {
    /** Both tools have a build: scans can run. */
    ready: boolean
    /** `stale` is still ready: old data is served and labelled, never refused. */
    status: 'ok' | 'stale' | 'not_ready'
    /** Why it is not ready. */
    reason?: string
    trivy?: ToolHealth
    grype?: ToolHealth
}

export interface DatabaseSource {
    lease(): LeaseResult
    health(): SourceHealth
}

export interface StaleHours {
    trivy: number
    grype: number
}

/** What a build looks like in an answer: no folder, which is ours. */
export function publicBuild(build: BuildInfo): DatabaseBuild & {age_seconds: number, stale: boolean} {
    return {built_at: build.built_at, schema: build.schema, age_seconds: build.age_seconds, stale: build.stale}
}

/**
 * The age and the stale flag, as of `now`. A `built_at` that does not parse counts as brand new
 * rather than ancient: it would be the publisher's format changing, not the data getting old, and
 * the scanners have already accepted the database.
 */
export function describeBuild(
    tool: ScannerName,
    dir: string,
    build: DatabaseBuild,
    staleHours: StaleHours,
    now: number,
): BuildInfo {
    const built = Date.parse(build.built_at)
    const age_seconds = Number.isNaN(built) ? 0 : Math.max(0, Math.floor((now - built) / 1000))
    return {tool, dir, built_at: build.built_at, schema: build.schema, age_seconds, stale: age_seconds > staleHours[tool] * 3600}
}

/**
 * The builds come from the store, which counts the leases on them; `/health` adds what each tool's
 * updater is doing. The store's pointer is the truth, and it only changes by an install in this
 * process.
 */
export function createDatabaseSource(
    store: {lease(): LeaseResult, current(tool: ScannerName): {dir: string, record: DatabaseBuild} | undefined},
    updaterStatus: (tool: ScannerName) => Partial<ToolHealth>,
    staleHours: StaleHours,
    now: () => number = Date.now,
): DatabaseSource {
    return {
        lease: () => store.lease(),
        health() {
            const at = now()
            const tools: Record<ScannerName, ToolHealth> = {trivy: {}, grype: {}}
            const missing: string[] = []
            for (const tool of ['trivy', 'grype'] as const) {
                const current = store.current(tool)
                const status = updaterStatus(tool)
                tools[tool] = {...current && publicBuild(describeBuild(tool, current.dir, current.record, staleHours, at)), ...status}
                if (!current) {
                    const doing = status.updating ? 'downloading' : status.last_error ? `no build (${status.last_error})` : 'no build yet'
                    missing.push(`${tool}: ${doing}`)
                }
            }
            if (missing.length > 0) return {ready: false, status: 'not_ready', reason: missing.join('; '), ...tools}
            const stale = tools.trivy.stale || tools.grype.stale
            return {ready: true, status: stale ? 'stale' : 'ok', ...tools}
        },
    }
}
