import {Cache} from './cache'
import path from 'path'
import fs from 'fs'
import {LibraryInfo} from '../extension-points/registrar'

const CACHE_FILE_NAME = 'libs.json'

function loadCache(): Map<string, LibraryInfo> {
    const cacheFile = path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME)
    if(!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.resolve(process.cwd(), 'cache'), {recursive: true})
        fs.writeFileSync(cacheFile, '{}')
    }
    const json = JSON.parse(fs.readFileSync(cacheFile, 'utf8').toString())
    return new Map(Object.entries(json))
}

let libMap: Map<string, LibraryInfo>
export const jsonCache: Cache = {
    get(key: string): LibraryInfo | undefined {
        if (!libMap) {
            this.load()
        }
        return libMap.get(key)
    }, set(key: string, value: any): void {
        if (!libMap) {
            this.load()
        }
        libMap.set(key, value)
    },
    has(key: string): boolean {
        if (!libMap) {
            this.load()
        }
        return libMap.has(key)
    },
    write() {
        fs.writeFileSync(path.resolve(process.cwd(), 'cache', 'libs.json'), JSON.stringify(Object.fromEntries(libMap)))
    },
    load() {
        libMap = loadCache()
    },
    getAll() {
        return libMap
    },
}