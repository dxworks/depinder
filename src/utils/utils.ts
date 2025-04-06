import path from 'path'
import {homedir} from 'os'
import fs from 'fs'
import {SemVer} from 'semver'
import semver from 'semver/preload'

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const _package = require('../../package.json')


export function getAssetFile(assetName: string): string {
    return path.join(__dirname, '..', 'assets', assetName)
}

export const npmExePath = getBin('npm')

function getBin(exe: string): string {
    return path.resolve(__dirname, '..', '..', 'node_modules', '.bin', exe)
}


export const depinderFolder = path.join(homedir(), '.dxw', 'depinder')
export const depinderTempFolder = path.join(depinderFolder, 'temp')

export function getHomeDir(): string {
    if (!fs.existsSync(depinderFolder)) {
        fs.mkdirSync(depinderFolder)
    }
    if (!fs.existsSync(depinderTempFolder)) {
        fs.mkdirSync(depinderTempFolder)
    }
    return depinderFolder
}

export function walkDir(dir: string): string[] {
    const allChildren = fs.readdirSync(dir)
    const files = allChildren.map(it => path.resolve(dir, it)).filter(it => fs.lstatSync(it).isFile())
    return [...files, ...allChildren.map(it => path.resolve(dir, it)).filter(it => fs.lstatSync(it).isDirectory()).flatMap(it => walkDir(path.resolve(dir, it)))]
}

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

export function getPackageSemver(version: string): SemVer | null {
    try {
        return new SemVer(version)
    } catch (e) {
        try {
            return new SemVer(version, {loose: true})

        } catch (e) {
            return semver.coerce(version)
        }
    }
}

export function readJSON<T>(filePath: string): T {
    const content = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(content)
}
