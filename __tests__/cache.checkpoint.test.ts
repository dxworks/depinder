import fs from 'fs'
import os from 'os'
import path from 'path'
import {Cache} from '../src/cache/cache'
import {openCacheDb, resetSharedCacheDb, sqliteCache} from '../src/cache/sqlite-cache'
import {mongoCache} from '../src/cache/mongo-cache'
import {LibraryInfo} from '../src/extension-points/registrar'

/**
 * The enrichment loop checkpoints the cache every 60 seconds so a crash loses at most that much
 * work. `write()` cannot serve that purpose: it is also the teardown step, and the Mongo cache
 * closes its connection there. A checkpoint that called it left every remaining lookup in the run
 * talking to a disconnected client — and because those failures are caught per dependency, the run
 * still finished and wrote CSVs whose enrichment was silently missing from the 60-second mark on.
 *
 * So the contract is: `flush()` makes progress durable and leaves the cache USABLE; `write()` may
 * tear down. These tests pin both halves of that.
 */

const library = (name: string): LibraryInfo => ({name, licenses: [], versions: []} as unknown as LibraryInfo)

describe('the cache checkpoint contract', () => {
    describe('the SQLite cache', () => {
        let tmp: string
        let dbFile: string

        beforeEach(() => {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-checkpoint-'))
            dbFile = path.join(tmp, 'cache', 'depinder.sqlite')
            process.env.DEPINDER_CACHE_DB = dbFile
            resetSharedCacheDb()
        })

        afterEach(() => {
            resetSharedCacheDb()
            delete process.env.DEPINDER_CACHE_DB
            fs.rmSync(tmp, {recursive: true, force: true})
        })

        it('makes entries durable on set, and stays usable after a flush', async () => {
            sqliteCache.load()
            await sqliteCache.set('npm:left-pad', library('left-pad'))

            await sqliteCache.flush?.()

            // Another connection sees the row: it is on disk, not in a map waiting for write().
            const other = openCacheDb(dbFile)
            expect(other.libKeys()).toContain('npm:left-pad')
            expect(other.getLib('npm:left-pad')?.name).toBe('left-pad')
            other.close()

            // The point of the fix: the cache still answers after a checkpoint.
            expect(await sqliteCache.has('npm:left-pad')).toBe(true)
            await sqliteCache.set('npm:right-pad', library('right-pad'))
            expect(await sqliteCache.has('npm:right-pad')).toBe(true)
        })

        it('imports a legacy libs.json once, and never downgrades a row already present', () => {
            const legacy = path.join(tmp, 'cache', 'libs.json')
            fs.mkdirSync(path.dirname(legacy), {recursive: true})
            fs.writeFileSync(legacy, JSON.stringify({'npm:left-pad': library('left-pad')}))

            sqliteCache.load()
            expect(sqliteCache.get('npm:left-pad')?.name).toBe('left-pad')

            // A second import (as `depinder cache import` would do) keeps what the database holds.
            sqliteCache.set('npm:left-pad', {...library('left-pad'), description: 'refreshed'})
            fs.writeFileSync(legacy, JSON.stringify({'npm:left-pad': library('left-pad'), 'npm:new': library('new')}))
            const counts = openCacheDb(dbFile).importLegacy(path.dirname(legacy))
            expect(counts.libs).toBe(1)
            expect(sqliteCache.get('npm:left-pad')?.description).toBe('refreshed')
            expect(sqliteCache.has('npm:new')).toBe(true)
        })

        it('reads DEPINDER_CACHE_DB, so a run can be pointed at its own database', () => {
            sqliteCache.load()
            const stats = openCacheDb(dbFile).stats()
            expect(stats.file).toBe(dbFile)
            expect(fs.existsSync(dbFile)).toBe(true)
        })
    })

    describe('the Mongo cache', () => {
        it('implements flush as a no-op, so a checkpoint cannot disconnect it', async () => {
            // Every `set` is an awaited upsert, so there is nothing to serialise — and `write()`
            // here is `mongoose.disconnect()`. Calling it mid-run is the bug this guards.
            expect(typeof mongoCache.flush).toBe('function')

            const disconnected = jest.fn()
            const mongoose = require('mongoose')
            const spy = jest.spyOn(mongoose, 'disconnect').mockImplementation(disconnected)
            try {
                await mongoCache.flush?.()
                expect(disconnected).not.toHaveBeenCalled()
            } finally {
                spy.mockRestore()
            }
        })
    })

    it('every cache that a run can choose implements flush', () => {
        // `analyse` calls `cache.flush?.()`, so a cache without one silently loses mid-run
        // durability rather than failing. Both caches a real run can pick must have it.
        const caches: Cache[] = [sqliteCache, mongoCache]
        for (const cache of caches) {
            expect(typeof cache.flush).toBe('function')
        }
    })
})
