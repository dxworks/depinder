import {access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {nullLogger} from '@depinder/core'
import {type ActiveScanners, createScannerBinaries, type ScannerBinaries} from '../../src/vuln/binaries.js'
import type {ScannerName} from '../../src/vuln/scanners.js'

/**
 * The switch, the rollback and the boot, over a real folder. Nothing is run: `probe` answers from
 * a table of what each binary path says its version is, or throws for a broken one.
 */

const IMAGE: ActiveScanners = {
    trivy: {bin: 'trivy', version: '0.74.0', source: 'image'},
    grype: {bin: 'grype', version: '0.118.0', source: 'image'},
}
const DB = 'mirror.gcr.io/aquasec/trivy-db:2'

let dataDir: string
/** bin path → the version it reports; missing means it does not run. */
let reports: Map<string, string>

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vuln-binaries-test-'))
    reports = new Map([['trivy', '0.74.0'], ['grype', '0.118.0']])
})

afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

async function open(options: {image?: ActiveScanners, selfUpdate?: Partial<Record<ScannerName, boolean>>} = {}): Promise<ScannerBinaries> {
    const binaries = createScannerBinaries({
        dataDir,
        image: options.image ?? IMAGE,
        selfUpdate: {trivy: true, grype: true, ...options.selfUpdate},
        probe: async (_tool, bin) => {
            const version = reports.get(bin)
            if (!version) throw new Error(`spawn ${bin} ENOENT`)
            return version
        },
        log: nullLogger,
        now: () => Date.parse('2026-11-17T12:00:00Z'),
    })
    await binaries.open()
    return binaries
}

/** A checked binary in staging, as the scanner update leaves it, that reports `version` once installed. */
async function staged(binaries: ScannerBinaries, tool: ScannerName, version: string): Promise<string> {
    const dir = await binaries.newStaging()
    const path = join(dir, tool)
    await writeFile(path, `#!${tool} ${version}`, {mode: 0o700})
    reports.set(join(dataDir, 'scanners', tool, version, tool), version)
    return path
}

const binPath = (tool: ScannerName, version: string): string => join(dataDir, 'scanners', tool, version, tool)
const versionsOnDisk = async (tool: ScannerName): Promise<string[]> => (await readdir(join(dataDir, 'scanners', tool))).sort()
const savedState = async () => JSON.parse(await readFile(join(dataDir, 'scanners', 'state.json'), 'utf8')) as Record<string, unknown>

describe('scanner binaries', () => {
    it('starts on the image\'s scanners with nothing downloaded', async () => {
        const binaries = await open()
        expect(binaries.active()).toEqual(IMAGE)
        expect(binaries.state('trivy')).toEqual({active: null, previous: null, rejected: {}, lastResult: null})
    })

    it('switches to a downloaded binary, executable, keeping the image\'s as the one before', async () => {
        const binaries = await open()
        await binaries.activate('trivy', '0.76.2', await staged(binaries, 'trivy', '0.76.2'))
        expect(binaries.active().trivy).toEqual({bin: binPath('trivy', '0.76.2'), version: '0.76.2', source: 'updated'})
        expect(binaries.active().grype).toEqual(IMAGE.grype)
        expect((await stat(binPath('trivy', '0.76.2'))).mode & 0o777).toBe(0o755)
        expect(binaries.state('trivy')).toMatchObject({active: '0.76.2', previous: null})
    })

    it('keeps the version before for rollback and deletes the one before that', async () => {
        const binaries = await open()
        for (const version of ['0.75.0', '0.76.0', '0.76.2']) {
            await binaries.activate('trivy', version, await staged(binaries, 'trivy', version))
        }
        expect(binaries.state('trivy')).toMatchObject({active: '0.76.2', previous: '0.76.0'})
        expect(await versionsOnDisk('trivy')).toEqual(['0.76.0', '0.76.2'])
    })

    it('rolls back to the version before, then to the image\'s, refusing the broken one each time', async () => {
        const binaries = await open()
        for (const version of ['0.75.0', '0.76.2']) {
            await binaries.activate('trivy', version, await staged(binaries, 'trivy', version))
        }
        await binaries.rollback('trivy', 'stopped working: exit 139', DB)
        expect(binaries.active().trivy).toMatchObject({version: '0.75.0', source: 'updated'})
        expect(binaries.isRejected('trivy', '0.76.2', DB)).toBe(true)
        expect(await versionsOnDisk('trivy')).toEqual(['0.75.0'])

        await binaries.rollback('trivy', 'stopped working: exit 139', DB)
        expect(binaries.active().trivy).toEqual(IMAGE.trivy)
        expect(await versionsOnDisk('trivy')).toEqual([])
        // Nothing left to roll back from.
        await binaries.rollback('trivy', 'again', DB)
        expect(binaries.active().trivy).toEqual(IMAGE.trivy)
    })

    it('keeps its choice and its refusals across a restart', async () => {
        const first = await open()
        await first.activate('grype', '0.122.0', await staged(first, 'grype', '0.122.0'))
        await first.reject('trivy', '0.76.0', 'smoke test: trivy missed 1 canary id(s)', DB)
        await writeFile(join(await first.newStaging(), 'half-download'), 'x')

        const second = await open()
        expect(second.active().grype).toEqual({bin: binPath('grype', '0.122.0'), version: '0.122.0', source: 'updated'})
        expect(second.isRejected('trivy', '0.76.0', DB)).toBe(true)
        expect((await readdir(join(dataDir, 'scanners'))).filter(name => name.startsWith('staging-'))).toEqual([])
        expect(await savedState()).toMatchObject({grype: {active: '0.122.0'}, trivy: {rejected: {'0.76.0': {db: DB}}}})
    })

    it('ties a refusal to the database source it was checked against', async () => {
        const binaries = await open()
        await binaries.reject('trivy', '0.80.0', 'smoke test: schema', DB)
        expect(binaries.isRejected('trivy', '0.80.0', DB)).toBe(true)
        expect(binaries.isRejected('trivy', '0.80.0', 'mirror.gcr.io/aquasec/trivy-db:3')).toBe(false)
        expect(binaries.isRejected('grype', '0.80.0', DB)).toBe(false)
    })

    it('rolls back at boot when the active binary no longer runs, and refuses it everywhere', async () => {
        const first = await open()
        for (const version of ['0.75.0', '0.76.2']) {
            await first.activate('trivy', version, await staged(first, 'trivy', version))
        }
        reports.delete(binPath('trivy', '0.76.2'))
        const second = await open()
        expect(second.active().trivy).toMatchObject({version: '0.75.0', source: 'updated'})
        expect(second.state('trivy')).toMatchObject({active: '0.75.0', previous: null})
        expect(second.isRejected('trivy', '0.76.2', 'any source')).toBe(true)
        expect(await versionsOnDisk('trivy')).toEqual(['0.75.0'])
    })

    it('falls back to the image\'s when no downloaded binary runs or reports its own version', async () => {
        const first = await open()
        await first.activate('trivy', '0.76.2', await staged(first, 'trivy', '0.76.2'))
        reports.set(binPath('trivy', '0.76.2'), '0.66.6')
        const second = await open()
        expect(second.active().trivy).toEqual(IMAGE.trivy)
        expect(second.isRejected('trivy', '0.76.2', DB)).toBe(true)
        expect(await versionsOnDisk('trivy')).toEqual([])
    })

    it('uses a newer image\'s binary over an older download, and deletes the download', async () => {
        const first = await open()
        await first.activate('trivy', '0.76.2', await staged(first, 'trivy', '0.76.2'))
        reports.set('trivy', '0.77.0')
        const second = await open({image: {...IMAGE, trivy: {...IMAGE.trivy, version: '0.77.0'}}})
        expect(second.active().trivy).toEqual({bin: 'trivy', version: '0.77.0', source: 'image'})
        expect(second.state('trivy')).toMatchObject({active: null, previous: null})
        // A version the image overtook was not broken.
        expect(second.isRejected('trivy', '0.76.2', DB)).toBe(false)
        expect(await versionsOnDisk('trivy')).toEqual([])
    })

    it('uses the image\'s (or pinned) binary when self-update is off for the tool', async () => {
        const first = await open()
        await first.activate('trivy', '0.76.2', await staged(first, 'trivy', '0.76.2'))
        const pinned = {...IMAGE, trivy: {bin: '/opt/trivy', version: '0.74.0', source: 'pinned' as const}}
        const second = await open({image: pinned, selfUpdate: {trivy: false}})
        expect(second.active().trivy).toEqual(pinned.trivy)
        expect(second.selfUpdate).toEqual({trivy: false, grype: true})
        expect(await versionsOnDisk('trivy')).toEqual([])
    })

    it('starts over from the image\'s scanners when state.json does not parse', async () => {
        await mkdir(join(dataDir, 'scanners', 'trivy', '0.76.2'), {recursive: true})
        await writeFile(join(dataDir, 'scanners', 'state.json'), '{"trivy": ')
        const binaries = await open()
        expect(binaries.active()).toEqual(IMAGE)
        expect(await versionsOnDisk('trivy')).toEqual([])
        expect(await savedState()).toMatchObject({trivy: {active: null}})
    })

    it('ignores a state.json that names a path instead of a version', async () => {
        await mkdir(join(dataDir, 'scanners'), {recursive: true})
        await writeFile(join(dataDir, 'scanners', 'state.json'), JSON.stringify({trivy: {active: '../../bin', previous: null, rejected: {}}}))
        const binaries = await open()
        expect(binaries.active().trivy).toEqual(IMAGE.trivy)
        await expect(access(join(dataDir, 'bin'))).rejects.toThrow()
    })
})
