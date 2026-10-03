import fs from 'fs'
import os from 'os'
import path from 'path'
import {cacheImportAction, cacheInfoAction} from '../src/commands/cache'
import {openCacheDb, resetSharedCacheDb} from '../src/cache/sqlite-cache'

describe('test cache commands', () => {
    let tmp: string
    let dbFile: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-cache-cmd-'))
        dbFile = path.join(tmp, 'db', 'depinder.sqlite')
        process.env.DEPINDER_CACHE_DB = dbFile
        resetSharedCacheDb()
    })

    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    test('cache info opens the database at DEPINDER_CACHE_DB', () => {
        cacheInfoAction()
        expect(fs.existsSync(dbFile)).toBe(true)
    })

    test('cache import copies a libs.json / misses.json folder into the database', () => {
        const legacy = path.join(tmp, 'legacy')
        fs.mkdirSync(legacy)
        fs.writeFileSync(path.join(legacy, 'libs.json'), JSON.stringify({'npm:left-pad': {name: 'left-pad', versions: []}}))
        fs.writeFileSync(path.join(legacy, 'misses.json'), JSON.stringify({'npm:gone': Date.now()}))

        cacheImportAction(legacy)
        resetSharedCacheDb()

        const db = openCacheDb(dbFile)
        expect(db.libKeys()).toEqual(['npm:left-pad'])
        expect(db.hasMiss('npm:gone')).toBe(true)
        db.close()
    })
})
