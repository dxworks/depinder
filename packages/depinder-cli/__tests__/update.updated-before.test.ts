import fs from 'fs'
import os from 'os'
import path from 'path'
import moment from 'moment'
import {updateLibs} from '../src/commands/update'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {LibraryInfo} from '../src/extension-points/library-info'

const lookup = vi.fn(async ({name}: {type: string, name: string}): Promise<LibraryInfo> => ({name, description: 'updated', licenses: [], versions: []}))

// The registries are stubbed; the plugin names select fake plugins by ecosystem.
vi.mock('../src/fallback/registry-fallback', () => ({
    createRegistryFallback: () => ({lookup: (pkg: {type: string, name: string}) => lookup(pkg), packagesAtOnce: () => 8}),
}))
vi.mock('../src/plugins', () => ({
    getPluginsFromNames: (names: string[]) => names.map(ecosystem => ({
        name: `fake-${ecosystem}`, ecosystem,
        extractor: {files: [], createContexts: () => []},
    })),
}))

describe('update with a date and plugins', () => {
    let tmp: string

    beforeEach(() => {
        lookup.mockClear()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-update-before-'))
        process.env.DEPINDER_CACHE_DB = path.join(tmp, 'depinder.sqlite')
        resetSharedCacheDb()
    })
    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    function cachedOn(key: string, date: string) {
        sharedCacheDb().setLib(key, {name: key.split(':')[1], description: 'cached', licenses: [], versions: []},
            moment(date).valueOf())
    }

    it('re-fetches only the selected plugins\' rows written before the date', async () => {
        cachedOn('gem:rails', '2023-01-01')
        cachedOn('gem:rack', '2024-01-01')
        cachedOn('npm:left-pad', '2023-01-01')

        await updateLibs('2023-09-23', ['gem'])

        expect(lookup.mock.calls).toEqual([[{type: 'gem', name: 'rails'}]])
        expect(sharedCacheDb().getLib('gem:rails')?.description).toBe('updated')
        expect(sharedCacheDb().getLib('gem:rack')?.description).toBe('cached')
        expect(sharedCacheDb().getLib('npm:left-pad')?.description).toBe('cached')
    })

    it('stamps a re-fetched row fresh, so the next run with the same date skips it', async () => {
        cachedOn('gem:rails', '2023-01-01')

        await updateLibs('2023-09-23', ['gem'])
        await updateLibs('2023-09-23', ['gem'])

        expect(lookup).toHaveBeenCalledTimes(1)
    })

    it('keeps the cached row when the registry lookup fails', async () => {
        cachedOn('gem:rails', '2023-01-01')
        lookup.mockRejectedValueOnce(new Error('registry down'))

        await updateLibs('2023-09-23', ['gem'])

        expect(sharedCacheDb().getLib('gem:rails')?.description).toBe('cached')
    })
})
