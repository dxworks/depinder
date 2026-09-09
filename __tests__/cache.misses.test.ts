import fs from 'fs'
import os from 'os'
import path from 'path'
import {MISS_TTL_HOURS, missCache, resetMissCache} from '../src/cache/misses'

describe('the negative cache', () => {
    let cwd: string
    let tmp: string

    beforeEach(() => {
        cwd = process.cwd()
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-misses-'))
        process.chdir(tmp)
        resetMissCache()
    })

    afterEach(() => {
        process.chdir(cwd)
        fs.rmSync(tmp, {recursive: true, force: true})
        resetMissCache()
    })

    it('starts empty when there is no file, and does not create one until something is recorded', () => {
        missCache.load()
        expect(missCache.has('npm:left-pad')).toBe(false)
        missCache.write()
        expect(fs.existsSync(path.join(tmp, 'cache', 'misses.json'))).toBe(false)
    })

    it('remembers a miss across a reload, and forgets it after the TTL', () => {
        missCache.set('maven:com.example:gone')
        missCache.write()
        resetMissCache()

        expect(missCache.has('maven:com.example:gone')).toBe(true)
        expect(missCache.has('maven:com.example:other')).toBe(false)

        const file = path.join(tmp, 'cache', 'misses.json')
        const stale = Date.now() - (MISS_TTL_HOURS + 1) * 60 * 60 * 1000
        fs.writeFileSync(file, JSON.stringify({'maven:com.example:gone': stale}))
        resetMissCache()
        expect(missCache.has('maven:com.example:gone')).toBe(false)
    })

    it('drops expired entries when it writes, so the file does not grow forever', () => {
        const file = path.join(tmp, 'cache', 'misses.json')
        fs.mkdirSync(path.dirname(file), {recursive: true})
        const stale = Date.now() - (MISS_TTL_HOURS + 1) * 60 * 60 * 1000
        fs.writeFileSync(file, JSON.stringify({'npm:old': stale}))

        missCache.set('npm:new')
        missCache.write()
        expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')))).toEqual(['npm:new'])
    })

    it('treats an unreadable file as empty rather than failing the run', () => {
        const file = path.join(tmp, 'cache', 'misses.json')
        fs.mkdirSync(path.dirname(file), {recursive: true})
        fs.writeFileSync(file, 'not json')
        expect(missCache.has('anything')).toBe(false)
    })
})
