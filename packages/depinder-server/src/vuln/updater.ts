import {rm} from 'node:fs/promises'
import {errorMessage, type Logger} from '@depinder/core'
import type {DatabaseBuild} from './databases.js'
import {type Clock, createLoop, type LoopStatus, type Mutex} from './loop.js'
import type {ScannerName} from './scanners.js'
import type {Store} from './store.js'
import type {UpstreamBuild} from './upstream.js'

/**
 * One tool's update loop, run twice side by side: a hung Grype download never delays a Trivy
 * update, and one small state machine is simpler than one that juggles both.
 *
 * Every `VULN_DB_CHECK_INTERVAL_MIN`, and once right after boot:
 *
 *   check     the publisher's metadata (`upstream.ts`); the same identity as the current build,
 *             or one already found not to be newer → nothing to do
 *   disk      less than twice a build's size free → skip, `low disk`
 *   download  the tool itself, into a fresh `staging/` folder, under `VULN_DB_DOWNLOAD_TIMEOUT_MS`
 *   inspect   the build time and schema the database itself reports
 *   newer     not newer than the current build → thrown away, its identity remembered
 *   smoke     `smoke.ts`, against the current build's canary findings
 *   install   `store.install`: the switch
 *
 * Anything that fails leaves the current build serving: the staging folder is removed, the error
 * is logged and kept for `/health`, and the next try comes sooner (`loop.ts`). At most one update
 * per tool runs at a time, and none while the tool's scanner binary is being updated (`lock`).
 */

export interface UpdaterDeps {
    tool: ScannerName
    store: Store
    check(signal: AbortSignal): Promise<UpstreamBuild>
    /** Fills the empty `stagingDir` with a build. */
    download(stagingDir: string, signal: AbortSignal): Promise<void>
    inspect(stagingDir: string, signal: AbortSignal): Promise<DatabaseBuild>
    /** Throws if the build fails; returns its canary findings. */
    smoke(stagingDir: string, baseline: number | null, signal: AbortSignal): Promise<number>
    freeBytes(path: string): Promise<number>
    /** One build on disk. A download needs twice this free: the build, and room to spare for the next. */
    buildBytes: number
    intervalMs: number
    clock?: Clock
    /** The tool's lock, shared with its scanner update. */
    lock?: Mutex
    log: Logger
}

interface UpdaterStatus extends LoopStatus {
    last_check_at: string | null
    upstream_built_at: string | null
}

export interface Updater {
    /** Runs the first check now and keeps going until `stop`. */
    start(): void
    /** Stops the loop and kills a download in flight; resolves once it is wound down. */
    stop(): Promise<void>
    /** One pass; while one runs, the same pass. */
    runOnce(): Promise<void>
    status(): UpdaterStatus
}

export function createUpdater(deps: UpdaterDeps): Updater {
    const {tool, store, log} = deps
    const now = (): number => deps.clock?.now() ?? Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString()

    /** An identity whose download turned out not to be newer: not fetched again. */
    let rejectedId: string | undefined
    const checked = {last_check_at: null as string | null, upstream_built_at: null as string | null}

    const newer = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b)

    const attempt = async (signal: AbortSignal): Promise<void> => {
        let staging: string | undefined
        try {
            let upstream: UpstreamBuild
            try {
                upstream = await deps.check(signal)
            } catch (e) {
                throw new Error(`check failed: ${errorMessage(e)}`)
            }
            checked.last_check_at = iso(now())
            checked.upstream_built_at = upstream.built_at

            const current = store.current(tool)
            if (current?.record.upstream_id === upstream.id || upstream.id === rejectedId) return
            if (current && upstream.exact && upstream.built_at && !newer(upstream.built_at, current.record.built_at)) {
                // Grype says its build time up front: no download to learn it is the one we have.
                return
            }

            const free = await deps.freeBytes(store.dataDir)
            if (free < 2 * deps.buildBytes) {
                throw new Error(`low disk: ${gb(free)} free in ${store.dataDir}, ${gb(2 * deps.buildBytes)} needed`)
            }

            const started = now()
            log.info('database download started', {tool, upstream_built_at: upstream.built_at, upstream_id: upstream.id})
            staging = await store.newStaging(tool)
            await deps.download(staging, signal)
            const build = await deps.inspect(staging, signal)
            if (current && !newer(build.built_at, current.record.built_at)) {
                // The check raced a publish, or a mirror is behind. Remember it, so it is not
                // downloaded again on every tick.
                rejectedId = upstream.id
                throw new Error(`downloaded build ${build.built_at} is not newer than the current ${current.record.built_at}`)
            }
            const findings = await deps.smoke(staging, current?.record.canary_findings ?? null, signal)

            const {previous} = await store.install(tool, staging, {
                tool,
                built_at: build.built_at,
                schema: build.schema,
                upstream_id: upstream.id,
                canary_findings: findings,
                installed_at: iso(now()),
            })
            staging = undefined
            log.info('database installed', {
                tool,
                built_at: build.built_at,
                previous: previous?.built_at ?? null,
                canary_findings: findings,
                took_ms: now() - started,
            })
        } finally {
            if (staging) await rm(staging, {recursive: true, force: true}).catch(() => undefined)
        }
    }

    const loop = createLoop({
        name: 'database update',
        fields: {tool},
        intervalMs: deps.intervalMs,
        clock: deps.clock,
        log,
        lock: deps.lock,
        attempt,
    })
    return {...loop, status: () => ({...loop.status(), ...checked})}
}

function gb(bytes: number): string {
    return `${(bytes / 1e9).toFixed(1)} GB`
}
