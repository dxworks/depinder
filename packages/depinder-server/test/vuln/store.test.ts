import {access, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {nullLogger} from '@depinder/core'
import type {ScannerName} from '../../src/vuln/scanners.js'
import {type BuildRecord, buildFolderName, createStore, type Store} from '../../src/vuln/store.js'

/**
 * The managed data folder on a real filesystem, with fake database files: the store never opens
 * them, it only needs them to be there.
 */

let dataDir: string

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vuln-store-test-'))
})

afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

const NOW = Date.parse('2026-10-01T20:00:00Z')

function store(): Store {
    return createStore({dataDir, staleHours: {trivy: 24, grype: 72}, log: nullLogger, now: () => NOW})
}

function record(tool: ScannerName, built_at: string, extra: Partial<BuildRecord> = {}): BuildRecord {
    return {tool, built_at, schema: tool === 'trivy' ? '2' : 'v6.1.9', upstream_id: `id-${built_at}`, canary_findings: 160,
        installed_at: '2026-10-01T20:00:00.000Z', ...extra}
}

/** A staging folder holding what the tool's download would have left there. */
async function staged(s: Store, tool: ScannerName): Promise<string> {
    const dir = await s.newStaging(tool)
    if (tool === 'trivy') {
        await mkdir(join(dir, 'db'))
        await writeFile(join(dir, 'db', 'trivy.db'), 'x')
        await writeFile(join(dir, 'db', 'metadata.json'), '{}')
    } else {
        await mkdir(join(dir, '6'))
        await writeFile(join(dir, '6', 'vulnerability.db'), 'x')
    }
    return dir
}

async function installBoth(s: Store, trivyAt = '2026-10-01T10:04:05.794145908Z', grypeAt = '2026-10-01T06:33:48Z'): Promise<void> {
    await s.install('trivy', await staged(s, 'trivy'), record('trivy', trivyAt))
    await s.install('grype', await staged(s, 'grype'), record('grype', grypeAt))
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const currentJson = async (): Promise<unknown> => JSON.parse(await readFile(join(dataDir, 'current.json'), 'utf8'))

describe('store', () => {
    it('installs by renaming staging into place and pointing current.json at it', async () => {
        const s = store()
        expect(await s.open()).toEqual({removed: [], corrupt: false})
        expect(s.lease()).toEqual({ready: false, reason: 'no trivy build yet; no grype build yet'})

        const staging = await staged(s, 'trivy')
        await s.install('trivy', staging, record('trivy', '2026-10-01T10:04:05.794145908Z'))
        expect(await exists(staging)).toBe(false)
        const dir = join(dataDir, 'trivy', '2026-10-01T100405.794145908Z')
        expect(await exists(join(dir, 'db', 'trivy.db'))).toBe(true)
        expect(JSON.parse(await readFile(join(dir, 'build.json'), 'utf8'))).toMatchObject({tool: 'trivy', canary_findings: 160})
        expect(await currentJson()).toEqual({trivy: '2026-10-01T100405.794145908Z'})
        expect(await exists(join(dataDir, 'current.json.tmp'))).toBe(false)
        expect(s.lease()).toEqual({ready: false, reason: 'no grype build yet'})

        await s.install('grype', await staged(s, 'grype'), record('grype', '2026-10-01T06:33:48Z'))
        expect(await currentJson()).toEqual({trivy: '2026-10-01T100405.794145908Z', grype: '2026-10-01T063348Z'})
        const lease = s.lease()
        expect(lease).toMatchObject({
            ready: true,
            trivy: {tool: 'trivy', dir, built_at: '2026-10-01T10:04:05.794145908Z', schema: '2', age_seconds: 35754, stale: false},
            grype: {tool: 'grype', dir: join(dataDir, 'grype', '2026-10-01T063348Z'), age_seconds: 48372, stale: false},
        })
    })

    it('keeps a leased build across an install and deletes it when the last lease is released', async () => {
        const s = store()
        await s.open()
        await installBoth(s)
        const first = s.lease()
        const second = s.lease()
        if (!first.ready || !second.ready) throw new Error('not ready')

        await s.install('trivy', await staged(s, 'trivy'), record('trivy', '2026-10-01T19:00:16.340316472Z'))
        const next = s.lease()
        if (!next.ready) throw new Error('not ready')
        // The new lease gets the new build; the old ones still hold the old, which is still there.
        expect(next.trivy.built_at).toBe('2026-10-01T19:00:16.340316472Z')
        expect(first.trivy.built_at).toBe('2026-10-01T10:04:05.794145908Z')
        expect(await exists(first.trivy.dir)).toBe(true)
        expect(s.builds()).toContainEqual({tool: 'trivy', folder: '2026-10-01T100405.794145908Z', refs: 2, current: false})

        first.release()
        first.release()
        await s.settled()
        expect(await exists(first.trivy.dir)).toBe(true)

        second.release()
        await s.settled()
        expect(await exists(first.trivy.dir)).toBe(false)
        expect(await readdir(join(dataDir, 'trivy'))).toEqual(['2026-10-01T190016.340316472Z'])
        // The Grype build is still current: releasing never deletes a current build.
        expect(await exists(first.grype.dir)).toBe(true)
        next.release()
        await s.settled()
        expect(await exists(next.trivy.dir)).toBe(true)
        expect(s.builds().map(b => b.refs)).toEqual([0, 0])
    })

    it('deletes the replaced build at once when nobody holds it', async () => {
        const s = store()
        await s.open()
        await installBoth(s)
        const old = join(dataDir, 'grype', '2026-10-01T063348Z')
        const {previous} = await s.install('grype', await staged(s, 'grype'), record('grype', '2026-10-02T06:30:00Z'))
        expect(previous?.built_at).toBe('2026-10-01T06:33:48Z')
        await s.settled()
        expect(await exists(old)).toBe(false)
    })

    it('refuses to install over a folder that exists', async () => {
        const s = store()
        await s.open()
        await installBoth(s)
        const staging = await staged(s, 'trivy')
        await expect(s.install('trivy', staging, record('trivy', '2026-10-01T10:04:05.794145908Z'))).rejects.toThrow(/already exists/)
        expect(s.current('trivy')?.folder).toBe('2026-10-01T100405.794145908Z')
    })

    it('boots from what current.json names, sweeping staging and leftover builds', async () => {
        const s = store()
        await s.open()
        await installBoth(s)
        // A download cut short, an install that died before current.json, a half-deleted build.
        await staged(s, 'grype')
        await mkdir(join(dataDir, 'trivy', '2026-10-01T190016Z', 'db'), {recursive: true})
        await mkdir(join(dataDir, 'grype', '2026-09-30T063348Z'), {recursive: true})

        const again = store()
        const opened = await again.open()
        expect(opened.trivy?.built_at).toBe('2026-10-01T10:04:05.794145908Z')
        expect(opened.grype?.built_at).toBe('2026-10-01T06:33:48Z')
        expect(opened.removed.sort()).toEqual(['grype/2026-09-30T063348Z', 'trivy/2026-10-01T190016Z'])
        expect(await readdir(join(dataDir, 'staging'))).toEqual([])
        expect(again.lease().ready).toBe(true)
    })

    it('drops a build that current.json names but that is not whole, and says so in current.json', async () => {
        const s = store()
        await s.open()
        await installBoth(s)
        await rm(join(dataDir, 'grype', '2026-10-01T063348Z', '6', 'vulnerability.db'))

        const again = store()
        const opened = await again.open()
        expect(opened.trivy).toBeDefined()
        expect(opened.grype).toBeUndefined()
        expect(opened.removed).toEqual(['grype/2026-10-01T063348Z'])
        expect(await currentJson()).toEqual({trivy: '2026-10-01T100405.794145908Z'})
        expect(again.lease()).toEqual({ready: false, reason: 'no grype build yet'})
    })

    it('is not ready on a corrupt current.json, and starts over clean', async () => {
        const s = store()
        await s.open()
        await installBoth(s)
        await writeFile(join(dataDir, 'current.json'), '{"trivy": "2026-10-01T1004')

        const again = store()
        const opened = await again.open()
        expect(opened.corrupt).toBe(true)
        expect(again.lease()).toEqual({ready: false, reason: 'no trivy build yet; no grype build yet'})
        expect(await readdir(join(dataDir, 'trivy'))).toEqual([])
        expect(await currentJson()).toEqual({})
    })

    it('refuses a current.json that points outside its folder', async () => {
        await mkdir(join(dataDir, 'trivy'), {recursive: true})
        await writeFile(join(dataDir, 'current.json'), JSON.stringify({trivy: '../../etc', grype: '..'}))
        const s = store()
        const opened = await s.open()
        expect(opened.trivy).toBeUndefined()
        expect(opened.grype).toBeUndefined()
    })

    it('names folders after the build time without colons', () => {
        expect(buildFolderName('2026-10-01T19:00:16.340316472Z')).toBe('2026-10-01T190016.340316472Z')
        expect(() => buildFolderName('::')).toThrow()
    })
})
