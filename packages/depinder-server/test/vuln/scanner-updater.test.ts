import {createHash} from 'node:crypto'
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {basename, join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {nullLogger, type Logger} from '@depinder/core'
import {createScannerBinaries, type ScannerBinaries} from '../../src/vuln/binaries.js'
import type {GithubRelease} from '../../src/vuln/releases.js'
import {createScannerUpdater, type ScannerUpdaterDeps} from '../../src/vuln/scanner-updater.js'
import {SignatureError} from '../../src/vuln/signatures.js'
import {SmokeError} from '../../src/vuln/smoke.js'

/**
 * One tool's scanner update over a real `scanners/` folder, with GitHub, the downloads, the
 * signature, the binary and the trial stubbed: each test decides what the release looks like and
 * which step goes wrong.
 */

const DAY = 86_400_000
const NOW = Date.parse('2026-11-17T12:00:00Z')
const DB = 'mirror.gcr.io/aquasec/trivy-db:2'
const ARCHIVE = Buffer.from('the 0.76.2 archive')
const ARCHIVE_SUM = createHash('sha256').update(ARCHIVE).digest('hex')

let dataDir: string
let binaries: ScannerBinaries
/** bin path → reported version; what `version` answers, and what `binaries.open` probes. */
let reports: Map<string, string>

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vuln-scanner-updater-test-'))
    reports = new Map([['trivy', '0.74.0'], ['grype', '0.118.0']])
    binaries = createScannerBinaries({
        dataDir,
        image: {trivy: {bin: 'trivy', version: '0.74.0', source: 'image'}, grype: {bin: 'grype', version: '0.118.0', source: 'image'}},
        selfUpdate: {trivy: true, grype: true},
        probe: async (_tool, bin) => reports.get(bin) ?? Promise.reject(new Error('ENOENT')),
        log: nullLogger,
    })
    await binaries.open()
})

afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

function release(tag: string, ageDays: number): GithubRelease {
    const v = tag.slice(1)
    return {
        tag_name: tag,
        draft: false,
        prerelease: false,
        published_at: new Date(NOW - ageDays * DAY).toISOString(),
        assets: [`trivy_${v}_Linux-64bit.tar.gz`, `trivy_${v}_checksums.txt`, `trivy_${v}_checksums.txt.sigstore.json`].map(name => ({name})),
    }
}

interface Calls {
    downloads: string[]
    trials: string[]
}

function updater(options: Partial<ScannerUpdaterDeps> & {checksums?: string, binaryReports?: string} = {}) {
    const calls: Calls = {downloads: [], trials: []}
    const deps: ScannerUpdaterDeps = {
        tool: 'trivy',
        binaries,
        currentDb: () => ({dir: '/data/trivy/build', canaryFindings: 160}),
        dbSource: DB,
        releases: async () => [release('v0.76.2', 12)],
        download: async (url, dest) => {
            calls.downloads.push(basename(url))
            const body = url.endsWith('.tar.gz') ? ARCHIVE
                : url.endsWith('.sigstore.json') ? Buffer.from('{"bundle": true}')
                    : Buffer.from(options.checksums ?? `${ARCHIVE_SUM}  ${basename(url).replace('_checksums.txt', '_Linux-64bit.tar.gz')}\n`)
            await writeFile(dest, body, {flag: 'wx'})
            return createHash('sha256').update(body).digest('hex')
        },
        verifySignature: async () => undefined,
        extract: async (archive, member, dest) => {
            await writeFile(dest, `binary ${member}`, {flag: 'wx'})
            reports.set(dest, options.binaryReports ?? basename(archive).split('_')[1]!)
        },
        version: async bin => {
            const version = reports.get(bin)
            if (!version) throw new Error(`'${bin} --version' failed: spawn failed: ENOENT`)
            return version
        },
        trial: async bin => {
            calls.trials.push(bin)
        },
        freeBytes: async () => 100e9,
        needBytes: 4.2e9,
        arch: 'x64',
        minAgeMs: 7 * DAY,
        intervalMs: 360 * 60_000,
        clock: {now: () => NOW, setTimeout: () => undefined, clearTimeout: () => undefined},
        log: nullLogger,
        ...options,
    }
    // Installed binaries report their version through `reports`, as `binaries.open` reads them.
    return {u: createScannerUpdater(deps), calls}
}

const installedPath = (version: string): string => join(dataDir, 'scanners', 'trivy', version, 'trivy')
const stagingLeft = async (): Promise<string[]> => (await readdir(join(dataDir, 'scanners'))).filter(name => name.startsWith('staging-'))

describe('scanner updater', () => {
    it('logs every step of an update, in order', async () => {
        const messages: string[] = []
        const log: Logger = {...nullLogger, info: msg => void messages.push(msg), child: () => log}
        await updater({log}).u.runOnce()
        expect(messages.filter(m => m.startsWith('scanner '))).toEqual([
            'scanner update started',
            'scanner signature verified',
            'scanner sha256 verified',
            'scanner binary unpacked and reports its version',
            'scanner trial passed',
            'scanner updated',
        ])
    })

    it('keeps the last result across a restart', async () => {
        await updater().u.runOnce()
        reports.set(installedPath('0.76.2'), '0.76.2')
        binaries = createScannerBinaries({
            dataDir,
            image: {trivy: {bin: 'trivy', version: '0.74.0', source: 'image'}, grype: {bin: 'grype', version: '0.118.0', source: 'image'}},
            selfUpdate: {trivy: true, grype: true},
            probe: async (_tool, bin) => reports.get(bin) ?? Promise.reject(new Error('ENOENT')),
            log: nullLogger,
        })
        await binaries.open()
        expect(updater({binaries}).u.status().last_result).toBe('installed 0.76.2, replacing 0.74.0')
    })

    it('downloads, verifies, tries and switches to a newer release, then has nothing to do', async () => {
        const {u, calls} = updater()
        await u.runOnce()
        expect(calls.downloads).toEqual(['trivy_0.76.2_checksums.txt', 'trivy_0.76.2_checksums.txt.sigstore.json', 'trivy_0.76.2_Linux-64bit.tar.gz'])
        expect(calls.trials).toHaveLength(1)
        expect(binaries.active().trivy).toEqual({bin: installedPath('0.76.2'), version: '0.76.2', source: 'updated'})
        expect(u.status()).toMatchObject({last_error: null, latest_release: '0.76.2', last_result: 'installed 0.76.2, replacing 0.74.0'})
        expect(await stagingLeft()).toEqual([])

        reports.set(installedPath('0.76.2'), '0.76.2')
        await u.runOnce()
        expect(calls.downloads).toHaveLength(3)
    })

    it('does nothing while the newest release is younger than the cooldown, or when it is ours', async () => {
        const young = updater({releases: async () => [release('v0.77.0', 3)]})
        await young.u.runOnce()
        expect(young.calls.downloads).toEqual([])
        expect(young.u.status()).toMatchObject({last_error: null, latest_release: '0.77.0', last_result: null})

        const same = updater({releases: async () => [release('v0.74.0', 90)]})
        await same.u.runOnce()
        expect(same.calls.downloads).toEqual([])
    })

    it('waits for a database before it judges a binary', async () => {
        const {u, calls} = updater({currentDb: () => undefined})
        await u.runOnce()
        expect(calls.downloads).toEqual([])
        expect(u.status()).toMatchObject({last_error: null, last_result: '0.76.2 waits for a trivy database'})
    })

    const refusals: [string, Parameters<typeof updater>[0], RegExp][] = [
        ['the signature does not verify', {verifySignature: async () => {
            throw new SignatureError('signature check failed for trivy 0.76.2: SIGNATURE_ERROR')
        }}, /SIGNATURE_ERROR/],
        ['the archive\'s sha256 is not the signed one', {checksums: `${'0'.repeat(64)}  trivy_0.76.2_Linux-64bit.tar.gz\n`},
            /sha256 of trivy_0.76.2_Linux-64bit.tar.gz is [0-9a-f]{64}, the signed checksums say 0{64}/],
        ['the checksums file has no entry for the archive', {checksums: `${ARCHIVE_SUM}  trivy_0.76.2_Linux-ARM64.tar.gz\n`},
            /no entry for trivy_0.76.2_Linux-64bit.tar.gz/],
        ['the archive does not hold the binary', {extract: async () => {
            throw new Error('trivy is not in the archive')
        }}, /unpacking .*not in the archive/],
        ['the binary reports another version', {binaryReports: '0.76.1'}, /reports version 0.76.1/],
        ['the smoke test fails with the new binary', {trial: async () => {
            throw new SmokeError('smoke test: trivy exit 1 — FATAL the local DB has an old schema version')
        }}, /old schema version.*newer database schema/],
    ]
    for (const [name, options, reason] of refusals) {
        it(`keeps the current binary and refuses the release for good when ${name}`, async () => {
            const {u, calls} = updater(options)
            await u.runOnce()
            expect(binaries.active().trivy.version).toBe('0.74.0')
            expect(u.status().last_error).toMatch(/^refused trivy 0.76.2: /)
            expect(u.status().last_error).toMatch(reason)
            expect(binaries.state('trivy').rejected['0.76.2']).toMatchObject({db: DB})
            expect(await stagingLeft()).toEqual([])

            const downloads = calls.downloads.length
            await u.runOnce()
            expect(calls.downloads).toHaveLength(downloads)
            expect(u.status().last_error).toBeNull()
        })
    }

    it('takes the next newest release once the newest is refused', async () => {
        await binaries.reject('trivy', '0.76.2', 'smoke test', DB)
        const {u, calls} = updater({releases: async () => [release('v0.76.2', 12), release('v0.75.0', 47)]})
        await u.runOnce()
        expect(calls.downloads).toContain('trivy_0.75.0_Linux-64bit.tar.gz')
        expect(binaries.active().trivy.version).toBe('0.75.0')
    })

    it('refuses a release that lacks its signature bundle, without downloading it', async () => {
        const unsigned = {...release('v0.76.2', 12), assets: [{name: 'trivy_0.76.2_Linux-64bit.tar.gz'}, {name: 'trivy_0.76.2_checksums.txt'}]}
        const {u, calls} = updater({releases: async () => [unsigned]})
        await u.runOnce()
        expect(calls.downloads).toEqual([])
        expect(u.status().last_error).toMatch(/refused trivy 0.76.2: the release has no trivy_0.76.2_checksums.txt.sigstore.json/)
    })

    const transient: [string, Parameters<typeof updater>[0], RegExp][] = [
        ['GitHub cannot be reached', {releases: async () => {
            throw new Error('fetch failed: ENOTFOUND api.github.com')
        }}, /^release check failed: fetch failed/],
        ['the trust root cannot be fetched', {verifySignature: async () => {
            throw new Error('sigstore trust root unavailable: timeout')
        }}, /trust root unavailable/],
        ['a download fails', {download: async () => {
            throw new Error('HTTP 502 from https://github.com/x')
        }}, /HTTP 502/],
        ['the disk is nearly full', {freeBytes: async () => 2e9}, /^low disk: 2\.0 GB free/],
    ]
    for (const [name, options, error] of transient) {
        it(`keeps the current binary and tries again later when ${name}`, async () => {
            const {u} = updater(options)
            await u.runOnce()
            expect(binaries.active().trivy.version).toBe('0.74.0')
            expect(u.status().last_error).toMatch(error)
            expect(binaries.state('trivy').rejected).toEqual({})
            expect(await stagingLeft()).toEqual([])
        })
    }

    it('refuses a release whose own database download fails three passes running', async () => {
        const {u, calls} = updater({trial: async () => {
            calls.trials.push('x')
            throw new Error('trivy: exit 1 — FATAL unknown flag: --download-db-only')
        }})
        await u.runOnce()
        await u.runOnce()
        expect(u.status().last_error).toMatch(/trial with trivy 0.76.2 failed \(2\/3\)/)
        expect(binaries.state('trivy').rejected).toEqual({})
        await u.runOnce()
        expect(u.status().last_error).toMatch(/refused trivy 0.76.2: trial failed 3 times, last: .*unknown flag/)
        await u.runOnce()
        expect(calls.trials).toHaveLength(3)
    })

    it('rolls back a downloaded binary that stopped working, and goes on from the one before', async () => {
        await binaries.activate('trivy', '0.76.2', await stagedBinary('0.76.2'))
        // Its binary no longer runs (not in `reports`).
        const {u, calls} = updater({releases: async () => [release('v0.76.2', 12)]})
        await u.runOnce()
        expect(binaries.active().trivy).toMatchObject({version: '0.74.0', source: 'image'})
        expect(binaries.isRejected('trivy', '0.76.2', DB)).toBe(true)
        expect(u.status().last_result).toMatch(/^rolled back 0.76.2 \(stopped working: .*ENOENT/)
        // The refused release is not downloaded again.
        expect(calls.downloads).toEqual([])
    })

    it('stops a pass in flight without refusing anything', async () => {
        let started: (() => void) | undefined
        const running = new Promise<void>(r => {
            started = r
        })
        const {u} = updater({trial: async (_bin, _db, signal) => {
            started!()
            await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
        }})
        const pass = u.runOnce()
        await running
        await u.stop()
        await pass
        expect(u.status()).toMatchObject({updating: false, last_error: null})
        expect(binaries.active().trivy.version).toBe('0.74.0')
        expect(binaries.state('trivy').rejected).toEqual({})
        expect(await stagingLeft()).toEqual([])
    })
})

async function stagedBinary(version: string): Promise<string> {
    const path = join(await binaries.newStaging(), 'trivy')
    await writeFile(path, `binary ${version}`)
    return path
}
