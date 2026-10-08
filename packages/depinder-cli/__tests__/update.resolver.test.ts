import fs from 'fs'
import os from 'os'
import path from 'path'
import type {PackageRecord} from '@depinder/core'
import {updateLibs} from '../src/commands/update'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {LibraryInfo} from '../src/extension-points/library-info'
import {ItemHandler, ResolvedEntry} from '../src/resolver/client'
import {ResolverConfig} from '../src/resolver/config'

const lookup = vi.fn(async ({name}: {type: string, name: string}): Promise<LibraryInfo> =>
    ({name, homepageUrl: 'from-registry', licenses: [], versions: []}))
const answers = new Map<string, ResolvedEntry>()
const resolvePurls = vi.fn(async (_config: ResolverConfig, purls: string[], _log?: unknown, onItem?: ItemHandler) => {
    const answered = new Map(purls.flatMap(purl => answers.has(purl) ? [[purl, answers.get(purl)!] as const] : []))
    for (const [purl, entry] of answered) onItem?.(purl, entry)
    return answered
})

vi.mock('../src/resolver/client', async importOriginal => ({
    ...await importOriginal<typeof import('../src/resolver/client')>(),
    resolvePurls: (...args: Parameters<typeof resolvePurls>) => resolvePurls(...args),
}))
vi.mock('../src/fallback/registry-fallback', () => ({
    createRegistryFallback: () => ({lookup: (pkg: {type: string, name: string}) => lookup(pkg), packagesAtOnce: () => 8}),
}))
vi.mock('../src/plugins', () => ({
    getPluginsFromNames: () => [{name: 'fake', ecosystem: 'npm', purlType: 'npm'}],
}))

const CONFIRMED_AT = '2026-10-01T12:00:00Z'

function record(name: string): PackageRecord {
    return {
        type: 'npm', namespace: null, name,
        description: null, homepage_url: 'from-resolver', repo_url: null, licenses: ['MIT'],
        latest: {version: '2.0.0', released_at: '2024-01-01T00:00:00Z'}, latest_prerelease: null,
        versions: [['2.0.0', Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000), 0]],
        as_of: null, source: 'test', fetched_at: CONFIRMED_AT, confirmed_at: CONFIRMED_AT,
    }
}

describe('update through the bulk resolver', () => {
    let tmp: string

    beforeEach(() => {
        lookup.mockClear()
        resolvePurls.mockClear()
        answers.clear()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-update-resolver-'))
        process.env.DEPINDER_CACHE_DB = path.join(tmp, 'depinder.sqlite')
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        resetSharedCacheDb()
    })
    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        delete process.env.DEPINDER_RESOLVER_TOKEN
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    function cachedStale(name: string, latest?: string) {
        const versions = latest ? [{version: latest, timestamp: 0, latest: true}] : []
        sharedCacheDb().setLib(`npm:${name}`, {name, homepageUrl: 'cached', licenses: [], versions}, 0)
    }

    it('asks the resolver first and leaves only what it did not answer to the registries', async () => {
        cachedStale('left-pad', '1.3.0')
        cachedStale('right-pad')
        answers.set('pkg:npm/left-pad@1.3.0', {status: 'resolved', package: record('left-pad')})
        answers.set('pkg:npm/right-pad', {status: 'not_found'})

        await updateLibs('', [])

        expect(resolvePurls).toHaveBeenCalledTimes(1)
        expect(resolvePurls.mock.calls[0][1]).toEqual(['pkg:npm/left-pad@1.3.0', 'pkg:npm/right-pad'])
        expect(lookup.mock.calls).toEqual([[{type: 'npm', name: 'right-pad'}]])
        expect(sharedCacheDb().getLib('npm:left-pad')?.homepageUrl).toBe('from-resolver')
        expect(sharedCacheDb().getLib('npm:right-pad')?.homepageUrl).toBe('from-registry')
        // Stamped with the server's confirmation time, as `analyse` writes it.
        expect(sharedCacheDb().libKeysUpdatedBefore(Date.parse(CONFIRMED_AT) + 1)).toEqual(['npm:left-pad'])
    })

    it('sends the stale cutoff as the freshness the server must meet', async () => {
        cachedStale('left-pad')

        await updateLibs('2026-01-01', [])

        expect(resolvePurls.mock.calls[0][0].freshAfterMs).toBe(Date.parse('2026-01-01T00:00:00'))
    })

    it('re-fetches a refreshing answer from the registry, since its facts are older than the cutoff', async () => {
        cachedStale('left-pad')
        answers.set('pkg:npm/left-pad', {status: 'refreshing', package: record('left-pad')})

        await updateLibs('', [])

        expect(lookup.mock.calls).toEqual([[{type: 'npm', name: 'left-pad'}]])
        expect(sharedCacheDb().getLib('npm:left-pad')?.homepageUrl).toBe('from-registry')
    })

    it('goes straight to the registries with --no-resolver', async () => {
        cachedStale('left-pad')

        await updateLibs('', [], {resolver: false})

        expect(resolvePurls).not.toHaveBeenCalled()
        expect(lookup.mock.calls).toEqual([[{type: 'npm', name: 'left-pad'}]])
    })
})
