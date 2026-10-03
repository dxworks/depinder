import type {MockInstance} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    cacheMaxAgeSeconds,
    DEFAULT_CACHE_MAX_AGE,
    formatDuration,
    freshnessCutoffMs,
    parseDuration,
} from '../src/cache/max-age'
import {openCacheDb, resetSharedCacheDb, sharedCacheDb, sqliteCacheWithCutoff} from '../src/cache/sqlite-cache'
import {missCache} from '../src/cache/misses'
import {CacheSession, runAnalysis} from '../src/commands/analyse'
import {cacheInfoAction} from '../src/commands/cache'
import {LibraryInfo} from '../src/extension-points/registrar'
import {DepinderDependency} from '../src/extension-points/extract'
import {Plugin} from '../src/extension-points/plugin'
import {log} from '../src/utils/logging'

vi.mock('../src/utils/blacklist', () => ({blacklistedGlobs: []}))

const DAY_MS = 86_400_000

const library = (name: string, description = 'cached'): LibraryInfo => ({name, description, licenses: [], versions: []})

describe('parseDuration', () => {
    it.each([
        ['90s', 90], ['30m', 1800], ['12h', 43_200], ['1d', 86_400], ['7d', 604_800],
        ['45', 45], ['0', 0], ['0s', 0], [' 2H ', 7200], ['1.5h', 5400],
    ])('reads %p as %p seconds', (raw, seconds) => {
        expect(parseDuration(raw)).toBe(seconds)
    })

    it.each(['', 'soon', '-1d', '1w', '1d2h', 'd'])('rejects %p', raw => {
        expect(parseDuration(raw)).toBeUndefined()
    })

    it('formats with the largest unit that divides it', () => {
        expect(formatDuration(86_400)).toBe('1d')
        expect(formatDuration(5400)).toBe('90m')
        expect(formatDuration(45)).toBe('45s')
        expect(formatDuration(0)).toBe('0s')
    })
})

describe('cacheMaxAgeSeconds', () => {
    const saved = process.env.DEPINDER_CACHE_MAX_AGE
    let warn: MockInstance

    beforeEach(() => {
        delete process.env.DEPINDER_CACHE_MAX_AGE
        warn = vi.spyOn(log, 'warn').mockImplementation(() => log)
    })
    afterEach(() => {
        warn.mockRestore()
        if (saved === undefined) delete process.env.DEPINDER_CACHE_MAX_AGE
        else process.env.DEPINDER_CACHE_MAX_AGE = saved
    })

    it('defaults to one day', () => {
        expect(DEFAULT_CACHE_MAX_AGE).toBe('1d')
        expect(cacheMaxAgeSeconds()).toBe(86_400)
    })

    it('reads DEPINDER_CACHE_MAX_AGE, and the flag wins over it', () => {
        process.env.DEPINDER_CACHE_MAX_AGE = '2h'
        expect(cacheMaxAgeSeconds()).toBe(7200)
        expect(cacheMaxAgeSeconds({cacheMaxAge: '30m'})).toBe(1800)
        expect(cacheMaxAgeSeconds({cacheMaxAge: '0'})).toBe(0)
    })

    it('warns and falls back to the default on a value it cannot read', () => {
        process.env.DEPINDER_CACHE_MAX_AGE = 'forever'
        expect(cacheMaxAgeSeconds()).toBe(86_400)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('DEPINDER_CACHE_MAX_AGE=forever'))

        expect(cacheMaxAgeSeconds({cacheMaxAge: '1 week'})).toBe(86_400)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('--cache-max-age=1 week'))
    })

    it('puts the cutoff max age before now', () => {
        expect(freshnessCutoffMs(3600, 10_000_000)).toBe(10_000_000 - 3_600_000)
    })
})

describe('cached packages expire', () => {
    let tmp: string
    let dbFile: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-max-age-'))
        dbFile = path.join(tmp, 'db', 'depinder.sqlite')
        process.env.DEPINDER_CACHE_DB = dbFile
        resetSharedCacheDb()
    })

    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    /** Writes `key` as if it had been cached `ageMs` ago. */
    function cachedAgo(key: string, ageMs: number, lib = library(key)) {
        const db = sharedCacheDb()
        db.setLib(key, lib)
        ;(db as any).db.prepare('UPDATE libs SET updated_at = ? WHERE key = ?').run(Date.now() - ageMs, key)
    }

    describe('the database', () => {
        it('answers a row at or after the cutoff, and not one before it', () => {
            const db = sharedCacheDb()
            db.setLib('npm:left-pad', library('left-pad'))
            const at = db.libUpdatedAt('npm:left-pad') as number

            expect(db.hasLib('npm:left-pad', at)).toBe(true)
            expect(db.getLib('npm:left-pad', at)?.name).toBe('left-pad')
            expect(db.hasLib('npm:left-pad', at + 1)).toBe(false)
            expect(db.getLib('npm:left-pad', at + 1)).toBeUndefined()
            // No cutoff: any age, as `update` reads it.
            expect(db.hasLib('npm:left-pad')).toBe(true)
            expect(db.getLib('npm:left-pad')?.name).toBe('left-pad')
        })

        it('makes an expired row fresh again when it is rewritten', () => {
            cachedAgo('npm:left-pad', 2 * DAY_MS)
            const cutoff = freshnessCutoffMs(86_400)
            expect(sharedCacheDb().hasLib('npm:left-pad', cutoff)).toBe(false)

            sharedCacheDb().setLib('npm:left-pad', library('left-pad', 'refreshed'))

            expect(sharedCacheDb().libUpdatedAt('npm:left-pad')).toBeGreaterThanOrEqual(cutoff + DAY_MS)
            expect(sharedCacheDb().getLib('npm:left-pad', cutoff)?.description).toBe('refreshed')
        })

        it('counts the rows written before a cutoff', () => {
            cachedAgo('npm:old', 2 * DAY_MS)
            cachedAgo('npm:new', 0)
            expect(sharedCacheDb().countLibsUpdatedBefore(freshnessCutoffMs(86_400))).toBe(1)
        })

        it('imports libs.json with the file\'s own age, so an old file imports as expired', () => {
            const legacy = path.join(tmp, 'legacy')
            fs.mkdirSync(legacy)
            const libsFile = path.join(legacy, 'libs.json')
            fs.writeFileSync(libsFile, JSON.stringify({'npm:left-pad': library('left-pad')}))
            const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS)
            fs.utimesSync(libsFile, twoDaysAgo, twoDaysAgo)

            sharedCacheDb().importLegacy(legacy)

            const db = sharedCacheDb()
            expect(db.libUpdatedAt('npm:left-pad')).toBe(Math.round(fs.statSync(libsFile).mtimeMs))
            expect(db.hasLib('npm:left-pad', freshnessCutoffMs(86_400))).toBe(false)
            expect(db.hasLib('npm:left-pad', freshnessCutoffMs(3 * 86_400))).toBe(true)
        })
    })

    describe('the analyse cache', () => {
        it('sees only fresh entries, and tells an expired one from a missing one', () => {
            cachedAgo('npm:old', 2 * DAY_MS)
            cachedAgo('npm:new', 0)
            const cache = sqliteCacheWithCutoff(freshnessCutoffMs(86_400))

            expect(cache.has('npm:new')).toBe(true)
            expect(cache.get('npm:new')?.name).toBe('npm:new')
            expect(cache.has('npm:old')).toBe(false)
            expect(cache.get('npm:old')).toBeUndefined()
            expect(cache.isExpired?.('npm:old')).toBe(true)
            expect(cache.isExpired?.('npm:new')).toBe(false)
            expect(cache.isExpired?.('npm:absent')).toBe(false)
        })

        it('writes a row with the age it is given: one confirmed before the cutoff reads as expired', () => {
            const cutoff = freshnessCutoffMs(86_400)
            const cache = sqliteCacheWithCutoff(cutoff)
            const confirmed = Date.now() - 2 * DAY_MS

            // A resolver answer the server last confirmed two days ago: stored, but not fresh.
            cache.set('npm:stale', library('stale'), confirmed)
            cache.set('npm:fresh', library('fresh'), cutoff + 1000)
            // No age given: now, as for a registry fetch.
            cache.set('npm:fetched', library('fetched'))

            expect(sharedCacheDb().libUpdatedAt('npm:stale')).toBe(confirmed)
            expect(cache.has('npm:stale')).toBe(false)
            expect(cache.get('npm:stale')).toBeUndefined()
            expect(cache.isExpired?.('npm:stale')).toBe(true)
            // Still there for `update` and `cache info`, which read any age.
            expect(sharedCacheDb().getLib('npm:stale')?.name).toBe('stale')
            expect(cache.has('npm:fresh')).toBe(true)
            expect(cache.has('npm:fetched')).toBe(true)
            expect(sharedCacheDb().libUpdatedAt('npm:fetched')).toBeGreaterThanOrEqual(cutoff + DAY_MS)
        })

        it('cache info reports fresh and expired counts at the max age given', () => {
            cachedAgo('npm:old', 2 * DAY_MS)
            cachedAgo('npm:new', 0)
            const info = vi.spyOn(log, 'info').mockImplementation(() => log)
            try {
                cacheInfoAction()
                expect(info).toHaveBeenCalledWith(expect.stringContaining('2 libraries (1 fresh, 1 expired at max age 1d)'))
                cacheInfoAction({cacheMaxAge: '3d'})
                expect(info).toHaveBeenCalledWith(expect.stringContaining('2 libraries (2 fresh, 0 expired at max age 3d)'))
            } finally {
                info.mockRestore()
            }
        })
    })

    /**
     * Phase 3 with no resolver: an expired entry is a miss, goes to the registry fallback, and whatever
     * comes back rewrites the row; when nothing comes back, the dependency is left without library
     * info, exactly like a library that was never cached.
     */
    describe('enrichment', () => {
        const input = () => {
            const file = path.join(tmp, 'app.lock')
            fs.writeFileSync(file, '')
            return file
        }

        // `runAnalysis` returns results for `sbom-*` plugins only, so the test keeps its own handle on
        // the dependency the parser hands out.
        let leftPad: DepinderDependency
        // Stands in for the registry fallback: the test's plugin answers what core would fetch.
        let registry: (name: string) => Promise<LibraryInfo>

        function fakePlugin(retrieve: (name: string) => Promise<LibraryInfo>): Plugin {
            registry = retrieve
            leftPad = {id: 'left-pad@1.0.0', name: 'left-pad', version: '1.0.0', semver: null, requestedBy: []}
            return {
                name: 'fake',
                ecosystem: 'npm',
                extractor: {files: ['*.lock'], createContexts: files => files.map(it => ({root: path.dirname(it), lockFile: path.basename(it)} as any))},
                parser: {
                    parseDependencyTree: () => ({
                        name: 'app', version: '1.0.0', path: '/repo/app',
                        dependencies: {'left-pad@1.0.0': leftPad},
                    }),
                },
                registrar: {retrieve: () => { throw new Error('analyse must not call the plugin registrar') }},
            }
        }

        async function analyse(plugin: Plugin, maxAgeSeconds: number) {
            const session: CacheSession = {
                cache: sqliteCacheWithCutoff(freshnessCutoffMs(maxAgeSeconds)),
                misses: missCache,
                checkpointIfDue: async () => { /* nothing to checkpoint */ },
                close: async () => { /* nothing to close */ },
            }
            const registries = {lookup: ({name}: {name: string}) => registry(name), packagesAtOnce: () => 8}
            await runAnalysis([input()], [plugin], path.join(tmp, 'out'), {results: 'out', refresh: false}, session, undefined, undefined, registries)
            return leftPad
        }

        it('answers a fresh entry locally', async () => {
            cachedAgo('npm:left-pad', 60_000, library('left-pad', 'cached'))
            const retrieve = vi.fn(async () => library('left-pad', 'from the registry'))

            const dep = await analyse(fakePlugin(retrieve), 86_400)

            expect(retrieve).not.toHaveBeenCalled()
            expect(dep?.libraryInfo?.description).toBe('cached')
        })

        it('sends an expired entry to the registry fallback and rewrites it with a new age', async () => {
            cachedAgo('npm:left-pad', 2 * DAY_MS, library('left-pad', 'cached'))
            const runStart = Date.now()
            const retrieve = vi.fn(async () => library('left-pad', 'from the registry'))

            const dep = await analyse(fakePlugin(retrieve), 86_400)

            expect(retrieve).toHaveBeenCalledWith('left-pad')
            expect(dep?.libraryInfo?.description).toBe('from the registry')
            expect(sharedCacheDb().getLib('npm:left-pad')?.description).toBe('from the registry')
            expect(sharedCacheDb().libUpdatedAt('npm:left-pad')).toBeGreaterThanOrEqual(runStart)
        })

        it('treats an expired entry nobody can answer for as missing, and records the miss', async () => {
            cachedAgo('npm:left-pad', 2 * DAY_MS, library('left-pad', 'cached'))
            const before = sharedCacheDb().libUpdatedAt('npm:left-pad')
            const retrieve = vi.fn(async () => { throw new Error('404') })

            const dep = await analyse(fakePlugin(retrieve), 86_400)

            expect(dep?.libraryInfo).toBeUndefined()
            expect(missCache.has('npm:left-pad')).toBe(true)
            // The expired row is left as it was, for whatever answers next time.
            expect(sharedCacheDb().libUpdatedAt('npm:left-pad')).toBe(before)
        })

        it('skips an expired entry with a live miss, as it skips any miss', async () => {
            cachedAgo('npm:left-pad', 2 * DAY_MS, library('left-pad', 'cached'))
            missCache.set('npm:left-pad')
            const retrieve = vi.fn(async () => library('left-pad', 'from the registry'))

            const dep = await analyse(fakePlugin(retrieve), 86_400)

            expect(retrieve).not.toHaveBeenCalled()
            expect(dep?.libraryInfo).toBeUndefined()
        })

        it('with a zero max age, fetches everything already on disk again', async () => {
            cachedAgo('npm:left-pad', 1000, library('left-pad', 'cached'))
            const retrieve = vi.fn(async () => library('left-pad', 'from the registry'))

            const dep = await analyse(fakePlugin(retrieve), 0)

            expect(retrieve).toHaveBeenCalledTimes(1)
            expect(dep?.libraryInfo?.description).toBe('from the registry')
        })
    })

    it('leaves the reopened database readable by a plain openCacheDb', () => {
        cachedAgo('npm:left-pad', 0)
        resetSharedCacheDb()
        const db = openCacheDb(dbFile)
        expect(db.libKeys()).toEqual(['npm:left-pad'])
        db.close()
    })
})
