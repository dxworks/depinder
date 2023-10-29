import {Cache} from './cache'
import path from 'path'
import fs from 'fs'
import {LibraryInfo, ProjectInfo} from '../extension-points/registrar'

const CACHE_FILE_NAME_LIBS = 'libs.json'
const CACHE_FILE_NAME_PROJECTS = 'projects.json'

function loadCacheLibrary(): Map<string, LibraryInfo> {
    const cacheFile = path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME_LIBS)
    if(!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.resolve(process.cwd(), 'cache'), {recursive: true})
        fs.writeFileSync(cacheFile, '{}')
    }
    const json = JSON.parse(fs.readFileSync(cacheFile, 'utf8').toString())
    return new Map(Object.entries(json))
}

function loadCacheProject(): Map<string, ProjectInfo> {
    const cacheFile = path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME_PROJECTS)
    if(!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.resolve(process.cwd(), 'cache'), {recursive: true})
        fs.writeFileSync(cacheFile, '{}')
    }
    const json = JSON.parse(fs.readFileSync(cacheFile, 'utf8').toString())
    return new Map(Object.entries(json))
}

let libMapLibrary: Map<string, LibraryInfo>
let libMapProject: Map<string, ProjectInfo>
export const jsonCacheLibrary: Cache = {
    get(key: string): LibraryInfo | undefined {
        if (!libMapLibrary) {
            this.load()
        }
        return libMapLibrary.get(key)
    }, set(key: string, value: any): void {
        if (!libMapLibrary) {
            this.load()
        }
        libMapLibrary.set(key, value)
    },
    has(key: string): boolean {
        if (!libMapLibrary) {
            this.load()
        }
        return libMapLibrary.has(key)
    },
    write() {
        fs.writeFileSync(path.resolve(process.cwd(), 'cache', 'libs.json'), JSON.stringify(Object.fromEntries(libMapLibrary)))
    },
    load() {
        libMapLibrary = loadCacheLibrary()
    },
    getAll() {
        return libMapLibrary
    },
}

export const jsonCacheProject: Cache = {
    get(key: string): ProjectInfo | undefined {
        if (!libMapProject) {
            this.load()
        }
        return libMapProject.get(key)
    }, set(key: string, value: any): void {
        if (!libMapProject) {
            this.load()
        }
        libMapProject.set(key, value)
    },
    has(key: string): boolean {
        if (!libMapProject) {
            this.load()
        }
        return libMapProject.has(key)
    },
    write() {
        fs.writeFileSync(path.resolve(process.cwd(), 'cache', 'libs.json'), JSON.stringify(Object.fromEntries(libMapProject)))
    },
    load() {
        libMapProject = loadCacheProject()
    },
    getAll() {
        return libMapProject
    },
}