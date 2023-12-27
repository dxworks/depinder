import {Cache} from './cache'
import path from 'path'
import fs from 'fs'
import {System} from '../../core/system'
import {Project} from '../../core/project'
import {LibraryInfo} from '../../core/library'

const CACHE_FILE_NAME_LIBS = 'libs.json'
const CACHE_FILE_NAME_PROJECTS = 'projects.json'
const CACHE_FILE_NAME_SYSTEMS = 'systems.json'

function loadCacheLibrary(): Map<string, LibraryInfo> {
    const cacheFile = path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME_LIBS)
    if(!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.resolve(process.cwd(), 'cache'), {recursive: true})
        fs.writeFileSync(cacheFile, '{}')
    }
    const json = JSON.parse(fs.readFileSync(cacheFile, 'utf8').toString())
    return new Map(Object.entries(json))
}

function loadCacheProject(): Map<string, Project> {
    const cacheFile = path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME_PROJECTS)
    if(!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.resolve(process.cwd(), 'cache'), {recursive: true})
        fs.writeFileSync(cacheFile, '{}')
    }
    const json = JSON.parse(fs.readFileSync(cacheFile, 'utf8').toString())
    return new Map(Object.entries(json))
}

function loadCacheSystem(): Map<string, System> {
    const cacheFile = path.resolve(process.cwd(), 'cache', CACHE_FILE_NAME_SYSTEMS)
    if(!fs.existsSync(cacheFile)) {
        fs.mkdirSync(path.resolve(process.cwd(), 'cache'), {recursive: true})
        fs.writeFileSync(cacheFile, '{}')
    }
    const json = JSON.parse(fs.readFileSync(cacheFile, 'utf8').toString())
    return new Map(Object.entries(json))
}

let libMapLibrary: Map<string, LibraryInfo>
let libMapProject: Map<string, Project>
let libMapSystem: Map<string, System>

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
    delete(key: string) {
        if (!libMapLibrary) {
            this.load()
        }
        libMapLibrary.delete(key)
    },
    findByField(key: string, value: any) {
        /// TODO: Implement or remove
        return undefined
    }
}

export const jsonCacheProject: Cache = {
    get(key: string): Project | undefined {
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
    delete(key: string) {
        if (!libMapProject) {
            this.load()
        }
        libMapProject.delete(key)
    },
    findByField(key: string, value: any) {
        /// TODO: Implement or remove
        return undefined
    }
}

export const jsonCacheSystem: Cache = {
    get(key: string): System | undefined {
        if (!libMapSystem) {
            this.load()
        }
        return libMapSystem.get(key)
    }, set(key: string, value: any): void {
        if (!libMapSystem) {
            this.load()
        }
        libMapSystem.set(key, value)
    },
    has(key: string): boolean {
        if (!libMapSystem) {
            this.load()
        }
        return libMapSystem.has(key)
    },
    write() {
        fs.writeFileSync(path.resolve(process.cwd(), 'cache', 'libs.json'), JSON.stringify(Object.fromEntries(libMapSystem)))
    },
    load() {
        libMapSystem = loadCacheSystem()
    },
    getAll() {
        return libMapProject
    },
    delete(key: string) {
        if (!libMapSystem) {
            this.load()
        }
        libMapSystem.delete(key)
    },
    findByField(key: string, value: any) {
        /// TODO: Implement or remove
        return undefined
    }
}