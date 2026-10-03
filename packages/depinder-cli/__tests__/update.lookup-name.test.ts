import fs from 'fs'
import os from 'os'
import path from 'path'
import {updateLibs} from '../src/commands/update'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {LibraryInfo} from '../src/extension-points/library-info'

const lookup = vi.fn(async ({name}: {type: string, name: string}): Promise<LibraryInfo> => ({name, licenses: ['MIT'], versions: []}))

vi.mock('../src/fallback/registry-fallback', () => ({
    createRegistryFallback: () => ({lookup: (pkg: {type: string, name: string}) => lookup(pkg), packagesAtOnce: () => 8}),
}))
vi.mock('../src/plugins', () => ({
    getPluginsFromNames: () => [{
        name: 'fake-go', ecosystem: 'go', aliases: ['sbom-golang'],
        extractor: {files: [], createContexts: () => []},
    }],
}))

describe('update of a lowercase golang cache key', () => {
    let tmp: string
    beforeEach(() => {
        lookup.mockClear()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-update-name-'))
        process.env.DEPINDER_CACHE_DB = path.join(tmp, 'depinder.sqlite')
        resetSharedCacheDb()
    })
    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    it('re-fetches under the cached module case and keeps the cache key', async () => {
        sharedCacheDb().setLib('go:github.com/masterminds/semver/v3', {name: 'github.com/Masterminds/semver/v3', licenses: [], versions: []}, 0)

        await updateLibs('', [])

        expect(lookup.mock.calls).toEqual([[{type: 'golang', name: 'github.com/Masterminds/semver/v3'}]])
        expect(sharedCacheDb().getLib('go:github.com/masterminds/semver/v3')?.licenses).toEqual(['MIT'])
    })
})
