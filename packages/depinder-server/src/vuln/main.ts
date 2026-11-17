import {rm, statfs} from 'node:fs/promises'
import {join} from 'node:path'
import {createLogger, errorMessage, type Logger} from '@depinder/core'
import {loadConfigOrExit} from '../shared/config.js'
import {type ActiveScanners, createScannerBinaries, type ScannerBinaries} from './binaries.js'
import {loadVulnConfig, type VulnConfig} from './config.js'
import {grypeStatusCommand, readGrypeBuild, readTrivyBuild} from './databases.js'
import {createScanLimiter} from './limiter.js'
import {createMutex, type Loop} from './loop.js'
import {downloadFile, extractFile, fetchReleases, supportedArch} from './releases.js'
import {createScannerUpdater, type ScannerUpdater} from './scanner-updater.js'
import {downloadGrypeDb, downloadTrivyDb, removeLeftoverScanDirs, type ScannerName, scannerVersion, scannerVersions, type ScannerVersions} from './scanners.js'
import {createVulnServer} from './server.js'
import {createSignatureVerifier} from './signatures.js'
import {smokeTest} from './smoke.js'
import {createDatabaseSource, type DatabaseSource, type StaleHours} from './source.js'
import {createStore, type Store, TOOLS} from './store.js'
import {checkGrype, checkTrivy} from './upstream.js'
import {createUpdater} from './updater.js'

/**
 * Boot for `ROLE=vuln`. No pools, no migrations: nothing here touches Postgres,
 * and nothing under `src/vuln/` imports anything that does.
 *
 * A scanner that is missing is a deployment mistake and stops the process here, with the setting
 * to fix. Databases that are missing are not: they are being downloaded, and the server starts and
 * answers 503 until they are there.
 */

/** One build on disk, measured on 2026-10-01: Trivy 1.47 GB, Grype 3.14 GB. A little over, rounded. */
const BUILD_BYTES: Record<ScannerName, number> = {trivy: 1.6e9, grype: 3.3e9}
/** A scanner update's room on top of a database download: the archive, the binary, and margin. */
const SCANNER_BYTES = 1e9

export async function startVuln(): Promise<void> {
    const config = loadConfigOrExit(loadVulnConfig)
    const log = createLogger(config.logLevel, {role: 'vuln'})

    let versions: ScannerVersions
    try {
        versions = await scannerVersions(config)
    } catch (e) {
        log.error('scanner check failed', {error: errorMessage(e)})
        process.exit(1)
    }
    log.info('image scanners', {trivy: versions.trivy, grype: versions.grype, trivyBin: config.trivyBin, grypeBin: config.grypeBin})

    const removed = await removeLeftoverScanDirs(config.tmpDir)
    if (removed > 0) log.info('removed leftover scan folders', {count: removed, tmpDir: config.tmpDir})

    const staleHours = {trivy: config.trivyStaleHours, grype: config.grypeStaleHours}
    const {source, loops, scanners} = await openVuln(config, versions, staleHours, log)

    const limiter = createScanLimiter(config.maxScans, config.maxQueued)
    const app = await createVulnServer({config, log, limiter, source, scanners})
    await app.listen({host: '0.0.0.0', port: config.port})
    log.info('vuln listening', {
        port: config.port,
        maxScans: config.maxScans,
        maxQueued: config.maxQueued,
        maxPurls: config.maxPurls,
        tmpDir: config.tmpDir,
    })
    for (const loop of loops) loop.start()

    let stopping = false
    const stop = async (signal: string): Promise<void> => {
        if (stopping) return
        stopping = true
        log.info('shutting down', {signal})
        // A download in flight is killed; its staging folder goes with it, or at the next boot.
        await Promise.all(loops.map(loop => loop.stop()))
        // Waits for the requests in flight, and so for their scans to finish.
        await app.close().catch(e => log.warn('vuln did not stop cleanly', {error: errorMessage(e)}))
        log.info('stopped')
        process.exit(0)
    }

    process.on('SIGTERM', () => void stop('SIGTERM'))
    process.on('SIGINT', () => void stop('SIGINT'))
}

interface Opened {
    source: DatabaseSource
    /** The database loops and the scanner loops, started once the server listens. */
    loops: Loop[]
    scanners: () => ActiveScanners
}

/**
 * `VULN_DATA_DIR`: the builds and the downloaded scanners on disk serve at once; each tool's two
 * loops keep them current, one at a time under the tool's lock. Every scanner call reads the
 * binary that is active at that moment, so the database loop uses a new binary from the switch on.
 */
async function openVuln(config: VulnConfig, versions: ScannerVersions, staleHours: StaleHours, log: Logger): Promise<Opened> {
    const dataDir = config.dataDir
    const store = createStore({dataDir, staleHours, log})
    const opened = await store.open()
    log.info('database store opened', {
        dataDir,
        trivy: opened.trivy?.built_at ?? null,
        grype: opened.grype?.built_at ?? null,
        removed: opened.removed,
    })
    const binaries = await openScanners(config, versions, log)
    const scanConfig = (): VulnConfig => {
        const active = binaries.active()
        return {...config, trivyBin: active.trivy.bin, grypeBin: active.grype.bin}
    }

    const freeBytes = async (path: string): Promise<number> => {
        const stats = await statfs(path)
        return stats.bavail * stats.bsize
    }
    const locks = {trivy: createMutex(), grype: createMutex()}
    const dbLoop = (tool: ScannerName) => createUpdater({
        tool,
        store,
        check: signal => tool === 'trivy'
            ? checkTrivy(config.trivyDbRepository, {signal})
            : checkGrype(config.grypeDbUpdateUrl, {signal}),
        download: (dir, signal) => tool === 'trivy' ? downloadTrivyDb(dir, scanConfig(), signal) : downloadGrypeDb(dir, scanConfig(), signal),
        inspect: (dir, signal) => tool === 'trivy' ? readTrivyBuild(dir) : readGrypeBuild(dir, grypeStatusCommand(scanConfig().grypeBin), signal),
        smoke: (dir, baseline, signal) => smokeTest(tool, dir, scanConfig(), baseline, signal),
        freeBytes,
        buildBytes: BUILD_BYTES[tool],
        intervalMs: config.checkIntervalMin * 60_000,
        lock: locks[tool],
        log,
    })
    const updaters = {trivy: dbLoop('trivy'), grype: dbLoop('grype')}

    const verifySignature = createSignatureVerifier(join(binaries.root, 'tuf'))
    const scannerLoop = (tool: ScannerName): ScannerUpdater | undefined => binaries.selfUpdate[tool] ? createScannerUpdater({
        tool,
        binaries,
        currentDb: () => {
            const current = store.current(tool)
            return current && {dir: current.dir, canaryFindings: current.record.canary_findings}
        },
        dbSource: tool === 'trivy' ? config.trivyDbRepository : config.grypeDbUpdateUrl,
        releases: signal => fetchReleases(tool, {signal}),
        download: (url, dest, maxBytes, signal) => downloadFile(url, dest, maxBytes, {signal, timeoutMs: config.downloadTimeoutMs}),
        verifySignature,
        extract: extractFile,
        version: (bin, signal) => scannerVersion(tool, bin, signal),
        trial: (bin, db, signal) => {
            const withNew = tool === 'trivy' ? {...scanConfig(), trivyBin: bin} : {...scanConfig(), grypeBin: bin}
            return scannerTrial(tool, bin, db, withNew, store, signal)
        },
        freeBytes,
        needBytes: 2 * BUILD_BYTES[tool] + SCANNER_BYTES,
        arch: process.arch,
        minAgeMs: config.scannerMinReleaseAgeDays * 86_400_000,
        intervalMs: config.scannerUpdateIntervalMin * 60_000,
        lock: locks[tool],
        log,
    }) : undefined
    const scannerUpdaters = {trivy: scannerLoop('trivy'), grype: scannerLoop('grype')}

    const source = createDatabaseSource(store, tool => {
        const active = binaries.active()[tool]
        const state = binaries.state(tool)
        return {
            ...updaters[tool].status(),
            scanner: {
                version: active.version,
                source: active.source,
                previous: state.previous,
                auto_update: binaries.selfUpdate[tool],
                ...scannerUpdaters[tool]?.status(),
            },
        }
    }, staleHours)
    const missing = TOOLS.filter(tool => !opened[tool])
    if (missing.length === 0) log.info('databases ready', {trivy: opened.trivy, grype: opened.grype})
    else log.warn('databases not ready; downloading, answering 503 until they are here', {missing})
    const loops: Loop[] = [updaters.trivy, updaters.grype, ...TOOLS.flatMap(tool => scannerUpdaters[tool] ?? [])]
    return {source, loops, scanners: () => binaries.active()}
}

/**
 * The downloaded scanners in `VULN_DATA_DIR/scanners`, over the image's. Self-update needs Linux
 * on x64 or arm64, the only builds it fetches; elsewhere (a laptop running `npm run dev`) it is off.
 */
async function openScanners(config: VulnConfig, versions: ScannerVersions, log: Logger): Promise<ScannerBinaries> {
    const platformOk = process.platform === 'linux' && supportedArch(process.arch)
    if (!platformOk && (config.scannerUpdate.trivy || config.scannerUpdate.grype)) {
        log.info('scanner self-update off: only linux on x64 or arm64 is supported', {platform: process.platform, arch: process.arch})
    }
    const selfUpdate = {trivy: platformOk && config.scannerUpdate.trivy, grype: platformOk && config.scannerUpdate.grype}
    const image: ActiveScanners = {
        trivy: {bin: config.trivyBin, version: versions.trivy, source: config.scannerUpdate.trivy ? 'image' : 'pinned'},
        grype: {bin: config.grypeBin, version: versions.grype, source: config.scannerUpdate.grype ? 'image' : 'pinned'},
    }
    const binaries = createScannerBinaries({
        dataDir: config.dataDir,
        image,
        selfUpdate,
        probe: (tool, bin) => scannerVersion(tool, bin),
        log,
    })
    await binaries.open()
    const active = binaries.active()
    log.info('scanners', {
        trivy: active.trivy.version, trivySource: active.trivy.source,
        grype: active.grype.version, grypeSource: active.grype.source,
        selfUpdate,
    })
    return binaries
}

/**
 * A new scanner binary's trial, before it may replace the current one: with it, download a
 * database from the configured source into staging, read it back and smoke-test it; then
 * smoke-test the current database too, which is what scans will read right after the switch. The
 * current build cannot change meanwhile: the tool's lock keeps its database loop out.
 */
async function scannerTrial(
    tool: ScannerName,
    bin: string,
    db: {dir: string, canaryFindings: number | null},
    config: VulnConfig,
    store: Store,
    signal: AbortSignal,
): Promise<void> {
    const staging = await store.newStaging(tool)
    try {
        if (tool === 'trivy') {
            await downloadTrivyDb(staging, config, signal)
            await readTrivyBuild(staging)
        } else {
            await downloadGrypeDb(staging, config, signal)
            await readGrypeBuild(staging, grypeStatusCommand(bin), signal)
        }
        await smokeTest(tool, staging, config, db.canaryFindings, signal)
    } finally {
        await rm(staging, {recursive: true, force: true}).catch(() => undefined)
    }
    await smokeTest(tool, db.dir, config, db.canaryFindings, signal)
}
