import fs from 'fs'
import os from 'os'
import path from 'path'
import {openCacheDb, resetSharedCacheDb, sharedCacheDb, sqliteCache} from '../src/cache/sqlite-cache'
import {LibraryInfo} from '../src/extension-points/library-info'

/** The SQLite library cache: durable on every `set`, usable for the whole process. */

const library = (name: string): LibraryInfo => ({name, licenses: [], versions: []} as unknown as LibraryInfo)

describe('the SQLite cache', () => {
    let tmp: string
    let dbFile: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-sqlite-cache-'))
        dbFile = path.join(tmp, 'cache', 'depinder.sqlite')
        process.env.DEPINDER_CACHE_DB = dbFile
        resetSharedCacheDb()
    })

    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    it('makes an entry durable as soon as it is set, and keeps answering', () => {
        sqliteCache.set('npm:left-pad', library('left-pad'))

        // Another connection sees the row: nothing waits for a save at the end of the run.
        const other = openCacheDb(dbFile)
        expect(other.libKeys()).toContain('npm:left-pad')
        expect(other.getLib('npm:left-pad')?.name).toBe('left-pad')
        other.close()

        expect(sqliteCache.has('npm:left-pad')).toBe(true)
        sqliteCache.set('npm:right-pad', library('right-pad'))
        expect(sqliteCache.has('npm:right-pad')).toBe(true)
    })

    it('imports a legacy libs.json once, and never downgrades a row already present', () => {
        const legacy = path.join(tmp, 'cache', 'libs.json')
        fs.mkdirSync(path.dirname(legacy), {recursive: true})
        fs.writeFileSync(legacy, JSON.stringify({'npm:left-pad': library('left-pad')}))

        expect(sqliteCache.get('npm:left-pad')?.name).toBe('left-pad')

        // A second import (as `depinder cache import` would do) keeps what the database holds.
        sqliteCache.set('npm:left-pad', {...library('left-pad'), homepageUrl: 'refreshed'})
        fs.writeFileSync(legacy, JSON.stringify({'npm:left-pad': library('left-pad'), 'npm:new': library('new')}))
        const counts = openCacheDb(dbFile).importLegacy(path.dirname(legacy))
        expect(counts.libs).toBe(1)
        expect(sqliteCache.get('npm:left-pad')?.homepageUrl).toBe('refreshed')
        expect(sqliteCache.has('npm:new')).toBe(true)
    })

    it('lists the keys last written before a cutoff, for `update`', () => {
        const db = openCacheDb(dbFile)
        db.setLib('npm:old', library('old'))
        const cutoff = Date.now() + 1
        while (Date.now() <= cutoff) { /* let the clock pass the cutoff */ }
        db.setLib('npm:new', library('new'))
        expect(db.libKeysUpdatedBefore(cutoff)).toEqual(['npm:old'])
        expect(db.libKeysUpdatedBefore(0)).toEqual([])
        db.close()
    })

    it('reads DEPINDER_CACHE_DB, so a run can be pointed at its own database', () => {
        expect(sharedCacheDb().file).toBe(dbFile)
        expect(openCacheDb(dbFile).stats().file).toBe(dbFile)
        expect(fs.existsSync(dbFile)).toBe(true)
    })
})
