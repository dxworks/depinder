import fs from 'fs'
import os from 'os'
import path from 'path'
import {Cache} from '../src/cache/cache'
import {jsonCache} from '../src/cache/json-cache'
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
    describe('the JSON cache', () => {
        let cwd: string
        let tmp: string

        beforeEach(() => {
            cwd = process.cwd()
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-checkpoint-'))
            process.chdir(tmp)
        })

        afterEach(() => {
            process.chdir(cwd)
            fs.rmSync(tmp, {recursive: true, force: true})
        })

        it('makes entries durable on flush, and stays usable afterwards', async () => {
            jsonCache.load()
            await jsonCache.set('npm:left-pad', library('left-pad'))

            await jsonCache.flush?.()

            const onDisk = JSON.parse(fs.readFileSync(path.resolve(tmp, 'cache', 'libs.json'), 'utf8'))
            expect(Object.keys(onDisk)).toContain('npm:left-pad')

            // The point of the fix: the cache still answers after a checkpoint.
            expect(await jsonCache.has('npm:left-pad')).toBe(true)
            await jsonCache.set('npm:right-pad', library('right-pad'))
            expect(await jsonCache.has('npm:right-pad')).toBe(true)
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
        const caches: Cache[] = [jsonCache, mongoCache]
        for (const cache of caches) {
            expect(typeof cache.flush).toBe('function')
        }
    })
})
