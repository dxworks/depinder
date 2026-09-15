import fs from 'fs'
import os from 'os'
import path from 'path'
import {MISS_TTL_HOURS, missCache} from '../src/cache/misses'
import {openCacheDb, resetSharedCacheDb} from '../src/cache/sqlite-cache'

describe('the negative cache', () => {
    let tmp: string
    let dbFile: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-misses-'))
        dbFile = path.join(tmp, 'cache', 'depinder.sqlite')
        process.env.DEPINDER_CACHE_DB = dbFile
        resetSharedCacheDb()
    })

    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    it('starts empty', () => {
        missCache.load()
        expect(missCache.has('npm:left-pad')).toBe(false)
    })

    it('remembers a miss across a reopen, and forgets it after the TTL', () => {
        missCache.set('maven:com.example:gone')
        resetSharedCacheDb()

        expect(missCache.has('maven:com.example:gone')).toBe(true)
        expect(missCache.has('maven:com.example:other')).toBe(false)

        resetSharedCacheDb()
        const db = openCacheDb(dbFile)
        const stale = Date.now() - (MISS_TTL_HOURS + 1) * 60 * 60 * 1000
        db.setMiss('maven:com.example:gone', stale)
        db.close()
        expect(missCache.has('maven:com.example:gone')).toBe(false)
    })

    it('drops expired entries when it writes, so the table does not grow forever', () => {
        const stale = Date.now() - (MISS_TTL_HOURS + 1) * 60 * 60 * 1000
        const db = openCacheDb(dbFile)
        db.setMiss('npm:old', stale)
        db.close()

        missCache.set('npm:new')
        missCache.write()
        resetSharedCacheDb()
        const after = openCacheDb(dbFile)
        expect(after.missKeys()).toEqual(['npm:new'])
        after.close()
    })

    it('imports a legacy misses.json once, when the database is created next to it', () => {
        const legacy = path.join(tmp, 'cache', 'misses.json')
        fs.mkdirSync(path.dirname(legacy), {recursive: true})
        const stale = Date.now() - (MISS_TTL_HOURS + 1) * 60 * 60 * 1000
        fs.writeFileSync(legacy, JSON.stringify({'npm:old': stale, 'npm:recent': Date.now(), 'npm:bad': 'x'}))

        expect(missCache.has('npm:recent')).toBe(true)
        expect(missCache.has('npm:old')).toBe(false)
        expect(missCache.has('npm:bad')).toBe(false)
        // The file is an input, never a target.
        expect(fs.existsSync(legacy)).toBe(true)
    })

    it('treats an unreadable legacy file as empty rather than failing the run', () => {
        const legacy = path.join(tmp, 'cache', 'misses.json')
        fs.mkdirSync(path.dirname(legacy), {recursive: true})
        fs.writeFileSync(legacy, 'not json')
        expect(missCache.has('anything')).toBe(false)
    })
})
