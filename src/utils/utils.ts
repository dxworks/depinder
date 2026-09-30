import path from 'path'
import {homedir} from 'os'
import fs from 'fs'

// eslint-disable-next-line @typescript-eslint/no-var-requires
export const _package = require('../../package.json')


export function getAssetFile(assetName: string): string {
    return path.join(__dirname, '..', 'assets', assetName)
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
