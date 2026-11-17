import {readFile, rm} from 'node:fs/promises'
import {join} from 'node:path'
import {errorMessage, type Logger} from '@depinder/core'
import type {ActiveScanner, ScannerBinaries} from './binaries.js'
import {type Clock, createLoop, type Loop, type LoopStatus, type Mutex} from './loop.js'
import {assetUrl, expectedSha256, type GithubRelease, releaseFiles, selectRelease} from './releases.js'
import type {ScannerName} from './scanners.js'
import {SignatureError, type VerifySignature} from './signatures.js'
import {SmokeError} from './smoke.js'

/**
 * One tool's scanner update: the binary, where `updater.ts` is the database. Every
 * `SCANNER_UPDATE_INTERVAL_MIN`, and once right after boot, under the tool's lock (`loop.ts`):
 *
 *   health    the active downloaded binary still answers `--version` with its version; if not, it
 *             is rolled back (`binaries.ts`) and the pass goes on from the binary rolled back to
 *   check     the tool's GitHub releases: the newest stable one, at least
 *             `SCANNER_MIN_RELEASE_AGE_DAYS` old, newer than ours and never refused; none → done
 *   wait      no database for the tool yet → done; a binary is only ever judged on a database
 *   disk      room for a database download and the archive, or `low disk`
 *   signature the checksums file and its Sigstore bundle; the bundle must verify (`signatures.ts`)
 *   sha256    the Linux archive for this CPU; its sum must be the checksums file's
 *   unpack    only the binary itself, out of the archive (`releases.ts`)
 *   version   the binary must say it is the release's version
 *   trial     with the new binary: a database download from the configured source, read back and
 *             smoke-tested, and the smoke test against the current database too (`trialRun`)
 *   switch    `binaries.activate`: new scans and the database loop use it from now on
 *
 * A release that fails signature, sha256, unpack, version or a smoke test is refused for good and
 * remembered in `scanners/state.json`. Anything else (the network, GitHub, the disk, a download
 * by the new binary) is retried with the usual backoff; a new binary whose own database download
 * fails three passes running is refused too. Whatever fails, the current binary keeps serving.
 *
 * Schemas: Trivy reads only the schema its `--db-repository` tag names (`trivy-db:2`), and Grype
 * only the schema its update URL serves (`v6`). A release that needs a newer schema cannot pass the
 * trial against the configured source, so it is refused rather than switched to; once
 * `TRIVY_DB_REPOSITORY` or `GRYPE_DB_UPDATE_URL` names the new schema, it is tried again (a
 * rejection is tied to the source it was checked against). Moving to a new schema is a deploy.
 */

/** A release refused for good. */
class Refused extends Error {}

/** A downloaded archive larger than this is not a scanner (Trivy 0.76.2's is 53 MB, Grype 0.122.0's 33 MB). */
const MAX_ARCHIVE_BYTES = 400e6
/** Nor is a binary larger than this (Trivy 0.76.2's is 176 MB). */
const MAX_BINARY_BYTES = 800e6
const MAX_SMALL_FILE_BYTES = 1e6
/** Database downloads by a new binary that may fail before it is refused. */
const MAX_TRIAL_FAILURES = 3

interface CurrentDb {
    /** The tool's current database build folder. */
    dir: string
    canaryFindings: number | null
}

export interface ScannerUpdaterDeps {
    tool: ScannerName
    binaries: ScannerBinaries
    /** The tool's current database build, or none yet. */
    currentDb(): CurrentDb | undefined
    /** The database source the trial uses: `TRIVY_DB_REPOSITORY` or `GRYPE_DB_UPDATE_URL`. */
    dbSource: string
    releases(signal: AbortSignal): Promise<GithubRelease[]>
    /** Downloads into the new file `dest`; returns its sha256. */
    download(url: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<string>
    verifySignature: VerifySignature
    extract(archive: string, member: string, dest: string, maxBytes: number): Promise<void>
    version(bin: string, signal: AbortSignal): Promise<string>
    /** Throws a `SmokeError` when the binary gets the canaries wrong, anything else when it could not try. */
    trial(bin: string, db: CurrentDb, signal: AbortSignal): Promise<void>
    freeBytes(path: string): Promise<number>
    /** Free bytes the pass needs: a database build twice, as the database update does, and the archive. */
    needBytes: number
    arch: NodeJS.Architecture
    minAgeMs: number
    intervalMs: number
    clock?: Clock
    lock?: Mutex
    log: Logger
}

interface ScannerUpdateStatus extends LoopStatus {
    last_check_at: string | null
    /** The newest stable release, whatever its age. */
    latest_release: string | null
    /** What the last pass that did something did: installed, refused, rolled back, waiting. */
    last_result: string | null
}

export interface ScannerUpdater extends Loop {
    status(): ScannerUpdateStatus
}

export function createScannerUpdater(deps: ScannerUpdaterDeps): ScannerUpdater {
    const {tool, binaries, log} = deps
    const now = (): number => deps.clock?.now() ?? Date.now()
    const iso = (ms: number): string => new Date(ms).toISOString()
    const trialFailures = new Map<string, number>()
    const checked = {last_check_at: null as string | null, latest_release: null as string | null, last_result: binaries.state(tool).lastResult}
    const result = async (text: string): Promise<void> => {
        checked.last_result = text
        await binaries.recordResult(tool, text).catch(e => log.warn('scanner result not saved', {tool, error: errorMessage(e)}))
    }

    /** The active downloaded binary still runs, or it is rolled back. */
    const health = async (signal: AbortSignal): Promise<void> => {
        const current = binaries.active()[tool]
        if (current.source !== 'updated') return
        try {
            const reported = await deps.version(current.bin, signal)
            if (reported !== current.version) throw new Error(`reports version ${reported}`)
        } catch (e) {
            if (signal.aborted) throw e
            const reason = `stopped working: ${errorMessage(e)}`
            await binaries.rollback(tool, reason, deps.dbSource)
            await result(`rolled back ${current.version} (${reason})`)
        }
    }

    /** The trial; a smoke failure refuses the release, three failures to try do too. */
    const trial = async (version: string, bin: string, db: CurrentDb, signal: AbortSignal): Promise<void> => {
        try {
            await deps.trial(bin, db, signal)
            trialFailures.delete(version)
            log.info('scanner trial passed', {tool, version})
        } catch (e) {
            if (signal.aborted) throw e
            if (e instanceof SmokeError) throw new Refused(`${e.message} (a release that needs a newer database schema fails here)`)
            const failures = (trialFailures.get(version) ?? 0) + 1
            trialFailures.set(version, failures)
            if (failures >= MAX_TRIAL_FAILURES) throw new Refused(`trial failed ${failures} times, last: ${errorMessage(e)}`)
            throw new Error(`trial with ${tool} ${version} failed (${failures}/${MAX_TRIAL_FAILURES}): ${errorMessage(e)}`)
        }
    }

    type Candidate = {version: string, tag: string, release: GithubRelease}

    const install = async (current: ActiveScanner, release: Candidate, db: CurrentDb, signal: AbortSignal): Promise<void> => {
        const started = now()
        let staging: string | undefined
        try {
            const files = releaseFiles(tool, release.version, deps.arch)
            const listed = new Set(release.release.assets.map(asset => asset.name))
            const absent = [files.checksums, files.bundle, files.archive].find(name => !listed.has(name))
            if (absent) throw new Refused(`the release has no ${absent}`)
            const free = await deps.freeBytes(binaries.root)
            if (free < deps.needBytes) throw new Error(`low disk: ${gb(free)} free in ${binaries.root}, ${gb(deps.needBytes)} needed`)

            log.info('scanner update started', {tool, from: current.version, to: release.version})
            staging = await binaries.newStaging()
            const bin = await fetchBinary(deps, release.version, release.tag, staging, signal)
            await trial(release.version, bin, db, signal)
            await binaries.activate(tool, release.version, bin)
        } catch (e) {
            if (e instanceof Refused && !signal.aborted) {
                await binaries.reject(tool, release.version, e.message, deps.dbSource)
                await result(`refused ${release.version}: ${e.message}`)
                log.error('scanner release refused', {tool, version: release.version, reason: e.message})
                throw new Error(`refused ${tool} ${release.version}: ${e.message}`)
            }
            throw e
        } finally {
            if (staging) await rm(staging, {recursive: true, force: true}).catch(() => undefined)
        }
        await result(`installed ${release.version}, replacing ${current.version}`)
        log.info('scanner updated', {tool, from: current.version, to: release.version, took_ms: now() - started})
    }

    const attempt = async (signal: AbortSignal): Promise<void> => {
        await health(signal)
        let releases: GithubRelease[]
        try {
            releases = await deps.releases(signal)
        } catch (e) {
            throw new Error(`release check failed: ${errorMessage(e)}`)
        }
        checked.last_check_at = iso(now())
        const current = binaries.active()[tool]
        const {candidate, latest} = selectRelease(releases, {
            current: current.version,
            minAgeMs: deps.minAgeMs,
            now: now(),
            rejected: version => binaries.isRejected(tool, version, deps.dbSource),
        })
        checked.latest_release = latest
        if (!candidate) return
        const db = deps.currentDb()
        if (!db) {
            await result(`${candidate.version} waits for a ${tool} database`)
            return
        }
        await install(current, candidate, db, signal)
    }

    const loop = createLoop({name: 'scanner update', fields: {tool}, intervalMs: deps.intervalMs, clock: deps.clock, log, lock: deps.lock, attempt})
    return {...loop, status: () => ({...loop.status(), ...checked})}
}

/** Signature, sha256, unpack, version: a binary at `staging/<tool>` that is the release's. Throws `Refused`. */
async function fetchBinary(deps: ScannerUpdaterDeps, version: string, tag: string, staging: string, signal: AbortSignal): Promise<string> {
    const {tool} = deps
    const files = releaseFiles(tool, version, deps.arch)
    const url = (name: string): string => assetUrl(tool, tag, name)
    const at = (name: string): string => join(staging, name)

    await deps.download(url(files.checksums), at(files.checksums), MAX_SMALL_FILE_BYTES, signal)
    await deps.download(url(files.bundle), at(files.bundle), MAX_SMALL_FILE_BYTES, signal)
    const checksums = await readFile(at(files.checksums))
    try {
        await deps.verifySignature(tool, version, checksums, await readFile(at(files.bundle), 'utf8'))
    } catch (e) {
        if (e instanceof SignatureError) throw new Refused(e.message)
        throw e
    }
    deps.log.info('scanner signature verified', {tool, version, file: files.checksums})
    let expected: string
    try {
        expected = expectedSha256(checksums.toString('utf8'), files.archive)
    } catch (e) {
        throw new Refused(errorMessage(e))
    }
    const actual = await deps.download(url(files.archive), at(files.archive), MAX_ARCHIVE_BYTES, signal)
    if (actual !== expected) throw new Refused(`sha256 of ${files.archive} is ${actual}, the signed checksums say ${expected}`)
    deps.log.info('scanner sha256 verified', {tool, version, file: files.archive, sha256: actual})

    const bin = at(tool)
    try {
        await deps.extract(at(files.archive), tool, bin, MAX_BINARY_BYTES)
    } catch (e) {
        throw new Refused(`unpacking ${files.archive}: ${errorMessage(e)}`)
    }
    await rm(at(files.archive), {force: true})
    let reported: string
    try {
        reported = await deps.version(bin, signal)
    } catch (e) {
        if (signal.aborted) throw e
        throw new Refused(`version check: ${errorMessage(e)}`)
    }
    if (reported !== version) throw new Refused(`the binary reports version ${reported}`)
    deps.log.info('scanner binary unpacked and reports its version', {tool, version})
    return bin
}

function gb(bytes: number): string {
    return `${(bytes / 1e9).toFixed(1)} GB`
}
