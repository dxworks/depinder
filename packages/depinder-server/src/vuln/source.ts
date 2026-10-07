import type {DatabaseBuild, DatabaseInfo, DbState} from './databases.js'
import type {ScannerName} from './scanners.js'

/**
 * Where a scan's databases come from, whichever mode the server runs in.
 *
 * A request leases one Trivy build and one Grype build for its whole scan: both scanners read the
 * builds the answer names, and a build that is replaced meanwhile stays on disk until the last
 * request reading it lets go. Frozen mode (`TRIVY_CACHE_DIR` + `GRYPE_DB_CACHE_DIR`) has one fixed
 * folder per tool and nothing to hold on to; managed mode (`VULN_DATA_DIR`, `store.ts`) has a
 * folder per build and counts the leases on each.
 *
 * `lease()` is synchronous so that nothing can change between the scan slot being granted and the
 * builds being pinned. Whatever needs a disk read happens before, in `refresh()`.
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

/** One tool on `/health`. The build fields are missing while it has none; the rest is managed mode's. */
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
    /** Brings what `lease` and `health` answer up to date. Awaited before either on every request. */
    refresh(): Promise<void>
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
 * Frozen mode: Phase 1's two folders, looked at through `createDatabaseInfo`, which re-reads them
 * only when one of the three files changed. Leasing pins nothing — the folders are someone else's,
 * and if they swap a database in place, scans already running are on their own, as before.
 */
export function createFrozenSource(
    info: DatabaseInfo,
    dirs: {trivy: string, grype: string},
    staleHours: StaleHours,
    now: () => number = Date.now,
): DatabaseSource {
    let state: DbState = {ready: false, reason: 'databases not read yet'}
    const describe = (tool: ScannerName, at: number): BuildInfo => {
        if (!state.ready) throw new Error('not ready')
        return describeBuild(tool, dirs[tool], state[tool], staleHours, at)
    }

    return {
        async refresh() {
            state = await info.current()
        },
        lease() {
            if (!state.ready) return {ready: false, reason: state.reason}
            const at = now()
            return {ready: true, trivy: describe('trivy', at), grype: describe('grype', at), release: () => undefined}
        },
        health() {
            if (!state.ready) return {ready: false, status: 'not_ready', reason: state.reason}
            const at = now()
            const trivy = publicBuild(describe('trivy', at))
            const grype = publicBuild(describe('grype', at))
            return {ready: true, status: trivy.stale || grype.stale ? 'stale' : 'ok', trivy, grype}
        },
    }
}

/**
 * Managed mode: the builds come from the store, which counts the leases on them; `/health` adds
 * what each tool's updater is doing. Nothing to refresh: the store's pointer is the truth, and it
 * only changes by an install in this process.
 */
export function createManagedSource(
    store: {lease(): LeaseResult, current(tool: ScannerName): {dir: string, record: DatabaseBuild} | undefined},
    updaterStatus: (tool: ScannerName) => Partial<ToolHealth>,
    staleHours: StaleHours,
    now: () => number = Date.now,
): DatabaseSource {
    return {
        async refresh() {},
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
