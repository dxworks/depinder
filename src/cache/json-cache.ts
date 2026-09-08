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
/** True once an entry was set that the file does not hold yet; `write` is a no-op otherwise. */
let dirty = false
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
        dirty = true
    },
    has(key: string): boolean {
        if (!libMap) {
            this.load()
        }
        return libMap.has(key)
    },
    // Serialising the whole map is the only way this cache becomes durable, so the mid-run
    // checkpoint and the end-of-run teardown are the same operation here.
    flush() {
        this.write()
    },
    write() {
        // Serialising a large cache (70 MB for a few thousand npm packuments) blocks the event
        // loop for a second or more, so it is only done when there is something new to save.
        if (!dirty) return
        fs.writeFileSync(path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME), JSON.stringify(Object.fromEntries(libMap)))
        dirty = false
    },
    load() {
        // The in-memory map is authoritative once loaded: this process is the only writer, and
        // every plugin in a run calls load(), so re-reading the file would just repeat the parse.
        if (libMap) return
        libMap = loadCache()
    },
}