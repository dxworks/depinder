import {statfs} from 'node:fs/promises'
import {createLogger, errorMessage, type Logger} from '../shared/log.js'
import {loadVulnConfigOrExit, type VulnConfig} from './config.js'
import {createDatabaseInfo, grypeStatusCommand, readGrypeBuild, readTrivyBuild} from './databases.js'
import {createScanLimiter} from './limiter.js'
import {downloadGrypeDb, downloadTrivyDb, removeLeftoverScanDirs, type ScannerName, scannerVersions, type ScannerVersions} from './scanners.js'
import {createVulnServer} from './server.js'
import {smokeTest} from './smoke.js'
import {createFrozenSource, createManagedSource, type DatabaseSource, type StaleHours} from './source.js'
import {createStore, TOOLS} from './store.js'
import {checkGrype, checkTrivy} from './upstream.js'
import {createUpdater, type Updater} from './updater.js'

/**
 * Boot for `ROLE=vuln`. No pools, no migrations, no notify bridge: nothing here touches Postgres,
 * and nothing under `src/vuln/` imports anything that does.
 *
 * A scanner that is missing is a deployment mistake and stops the process here, with the setting
 * to fix. Databases that are missing are not: in frozen mode they may simply not have arrived yet,
 * in managed mode they are being downloaded, and either way the server starts and answers 503
 * until they are there.
 */

/** One build on disk, measured on 2026-10-01: Trivy 1.47 GB, Grype 3.14 GB. A little over, rounded. */
const BUILD_BYTES: Record<ScannerName, number> = {trivy: 1.6e9, grype: 3.3e9}

export async function startVuln(): Promise<void> {
    const config = loadVulnConfigOrExit()
    const log = createLogger(config.logLevel, {role: 'vuln'})

    let versions: ScannerVersions
    try {
        versions = await scannerVersions(config)
    } catch (e) {
        log.error('scanner check failed', {error: errorMessage(e)})
        process.exit(1)
    }
    log.info('scanners', {trivy: versions.trivy, grype: versions.grype, trivyBin: config.trivyBin, grypeBin: config.grypeBin})

    const removed = await removeLeftoverScanDirs(config.tmpDir)
    if (removed > 0) log.info('removed leftover scan folders', {count: removed, tmpDir: config.tmpDir})

    const staleHours = {trivy: config.trivyStaleHours, grype: config.grypeStaleHours}
    const {source, updaters} = config.mode === 'managed'
        ? await managed(config, staleHours, log)
        : await frozen(config, staleHours, log)

    const limiter = createScanLimiter(config.maxScans, config.maxQueued)
    const app = await createVulnServer({config, log, limiter, source, versions})
    await app.listen({host: '0.0.0.0', port: config.port})
    log.info('vuln listening', {
        port: config.port,
        mode: config.mode,
        maxScans: config.maxScans,
        maxQueued: config.maxQueued,
        maxPurls: config.maxPurls,
        tmpDir: config.tmpDir,
    })
    for (const updater of updaters) updater.start()

    let stopping = false
    const stop = async (signal: string): Promise<void> => {
        if (stopping) return
        stopping = true
        log.info('shutting down', {signal})
        // A download in flight is killed; its staging folder goes with it, or at the next boot.
        await Promise.all(updaters.map(updater => updater.stop()))
        // Waits for the requests in flight, and so for their scans to finish.
        await app.close().catch(e => log.warn('vuln did not stop cleanly', {error: errorMessage(e)}))
        log.info('stopped')
        process.exit(0)
    }

    process.on('SIGTERM', () => void stop('SIGTERM'))
    process.on('SIGINT', () => void stop('SIGINT'))
}

/** Phase 1: two folders someone else fills. */
async function frozen(config: VulnConfig, staleHours: StaleHours, log: Logger): Promise<{source: DatabaseSource, updaters: Updater[]}> {
    const dirs = {trivy: config.trivyCacheDir!, grype: config.grypeDbCacheDir!}
    const source = createFrozenSource(createDatabaseInfo({...config, trivyCacheDir: dirs.trivy, grypeDbCacheDir: dirs.grype}), dirs, staleHours)
    await source.refresh()
    const health = source.health()
    if (health.ready) log.info('databases ready', {mode: 'frozen', trivy: health.trivy, grype: health.grype})
    else log.warn('databases not ready; answering 503 until they are', {mode: 'frozen', reason: health.reason})
    return {source, updaters: []}
}

/** `VULN_DATA_DIR`: the builds on disk serve at once; each tool's loop keeps them current. */
async function managed(config: VulnConfig, staleHours: StaleHours, log: Logger): Promise<{source: DatabaseSource, updaters: Updater[]}> {
    const dataDir = config.dataDir!
    const store = createStore({dataDir, staleHours, log})
    const opened = await store.open()
    log.info('database store opened', {
        dataDir,
        trivy: opened.trivy?.built_at ?? null,
        grype: opened.grype?.built_at ?? null,
        removed: opened.removed,
    })

    const grypeStatus = grypeStatusCommand(config.grypeBin)
    const freeBytes = async (path: string): Promise<number> => {
        const stats = await statfs(path)
        return stats.bavail * stats.bsize
    }
    const make = (tool: ScannerName): Updater => createUpdater({
        tool,
        store,
        check: signal => tool === 'trivy'
            ? checkTrivy(config.trivyDbRepository, {signal})
            : checkGrype(config.grypeDbUpdateUrl, {signal}),
        download: (dir, signal) => tool === 'trivy' ? downloadTrivyDb(dir, config, signal) : downloadGrypeDb(dir, config, signal),
        inspect: (dir, signal) => tool === 'trivy' ? readTrivyBuild(dir) : readGrypeBuild(dir, grypeStatus, signal),
        smoke: (dir, baseline, signal) => smokeTest(tool, dir, config, baseline, signal),
        freeBytes,
        buildBytes: BUILD_BYTES[tool],
        intervalMs: config.checkIntervalMin * 60_000,
        log,
    })
    const updaters = {trivy: make('trivy'), grype: make('grype')}

    const source = createManagedSource(store, tool => updaters[tool].status(), staleHours)
    const missing = TOOLS.filter(tool => !opened[tool])
    if (missing.length === 0) log.info('databases ready', {mode: 'managed', trivy: opened.trivy, grype: opened.grype})
    else log.warn('databases not ready; downloading, answering 503 until they are here', {mode: 'managed', missing})
    return {source, updaters: [updaters.trivy, updaters.grype]}
}
