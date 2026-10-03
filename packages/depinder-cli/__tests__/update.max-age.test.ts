import fs from 'fs'
import os from 'os'
import path from 'path'
import {updateLibs} from '../src/commands/update'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {LibraryInfo} from '../src/extension-points/registrar'

const lookup = vi.fn(async ({name}: {type: string, name: string}): Promise<LibraryInfo> => ({name, description: 'updated', licenses: [], versions: []}))

// No real registries: `update` would otherwise go to npm for every expired row.
vi.mock('../src/fallback/registry-fallback', () => ({
    createRegistryFallback: () => ({lookup: (pkg: {type: string, name: string}) => lookup(pkg), packagesAtOnce: () => 8}),
}))
vi.mock('../src/plugins', () => ({
    getPluginsFromNames: () => [{
        name: 'fake', ecosystem: 'npm',
        extractor: {files: [], createContexts: () => []},
    }],
}))

describe('update with no date', () => {
    let tmp: string

    beforeEach(() => {
        lookup.mockClear()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-update-age-'))
        process.env.DEPINDER_CACHE_DB = path.join(tmp, 'depinder.sqlite')
        resetSharedCacheDb()
    })
    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    function cachedAgo(key: string, ageMs: number) {
        const db = sharedCacheDb()
        db.setLib(key, {name: key, description: 'cached', licenses: [], versions: []})
        ;(db as any).db.prepare('UPDATE libs SET updated_at = ? WHERE key = ?').run(Date.now() - ageMs, key)
    }

    it('re-fetches exactly the rows past the cache max age', async () => {
        cachedAgo('npm:old', 2 * 86_400_000)
        cachedAgo('npm:new', 60_000)

        await updateLibs('', [])

        expect(lookup.mock.calls).toEqual([[{type: 'npm', name: 'old'}]])
        expect(sharedCacheDb().getLib('npm:old')?.description).toBe('updated')
        expect(sharedCacheDb().getLib('npm:new')?.description).toBe('cached')
    })

    it('takes the max age from --cache-max-age', async () => {
        cachedAgo('npm:old', 2 * 86_400_000)
        cachedAgo('npm:new', 60_000)

        await updateLibs('', [], {cacheMaxAge: '30s'})

        expect(lookup.mock.calls.map(it => it[0].name).sort()).toEqual(['new', 'old'])
    })

    it('still lets an explicit date win', async () => {
        cachedAgo('npm:old', 2 * 86_400_000)

        await updateLibs('2000-01-01', [])

        expect(lookup).not.toHaveBeenCalled()
    })
})

describe('update registry limits', () => {
    it('rejects a bad --registry-limits before reading the cache', async () => {
        await expect(updateLibs('', [], {registryLimits: 'npm=0'})).rejects.toThrow(/--registry-limits/)
    })
})
