import {Command} from 'commander'
import {execSync} from 'child_process'
import chalk from 'chalk'
import fs from 'fs'
import {getAssetFile, getHomeDir} from '../utils/utils'
import path from 'path'
import {log} from '../utils/logging'
import {defaultCacheDbFile, sharedCacheDb} from '../cache/sqlite-cache'

export async function cacheUpAction(): Promise<void> {
    execSync('docker-compose up -d', {cwd: path.resolve(getHomeDir(), 'cache'), stdio: 'inherit'})
}

export async function cacheDownAction(): Promise<void> {
    execSync('docker-compose down', {cwd: path.resolve(getHomeDir(), 'cache'), stdio: 'inherit'})
}

export function getMongoDockerContainerStatus(): string | null {
    try {
        const output = execSync('docker inspect depinder-mongo').toString()
        const result: any[] = JSON.parse(output)
        if (result.length == 0) {
            log.error('Mongo is not running')
            return null
        }
        return result[0].State.Status
    } catch (e) {
        return null
    }

}

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The local SQLite cache: where it is and what it holds. Printed by every `cache info`. */
export function sqliteCacheInfoAction(): void {
    const stats = sharedCacheDb().stats()
    log.info(`Local cache: ${chalk.yellow(stats.file)} (${formatBytes(stats.bytes)})`)
    log.info(`  ${stats.libs} libraries, ${stats.misses} misses`)
}

/**
 * Pulls the JSON files of the previous layout — `libs.json` and `misses.json` in `<dir>` — into
 * the global database. The files are left untouched; an entry already in the
 * database is kept, so importing a run's cache never overwrites a newer answer.
 */
export function cacheImportAction(dir: string): void {
    const counts = sharedCacheDb().importLegacy(path.resolve(dir))
    log.info(`Imported from ${chalk.yellow(path.resolve(dir))} into ${defaultCacheDbFile()}:`)
    log.info(`  ${counts.libs} libraries, ${counts.misses} misses (existing rows kept)`)
}

export function cacheInfoAction(): void {
    sqliteCacheInfoAction()
    const status = getMongoDockerContainerStatus()
    if (status == null) {
        log.error('Mongo is not running')
        log.info(`To start Mongo cache run: ${chalk.yellow('depinder cache up')}`)
        return
    }
    if (status == 'running') {
        log.info(chalk.green('Mongo cache is up and running'))
    } else {
        log.info(`Mongo is ${status}`)
        log.info(`To start Mongo cache run: ${chalk.yellow('depinder cache up')}`)
    }
}

export function cacheInitAction(): void {
    if (!fs.existsSync(path.join(getHomeDir(), 'cache', 'docker-compose.yml'))) {
        fs.mkdirSync(path.join(getHomeDir(), 'cache'), {recursive: true})
        fs.copyFileSync(getAssetFile('depinder.docker-compose.yml'), path.join(getHomeDir(), 'cache', 'docker-compose.yml'))
        fs.copyFileSync(getAssetFile('init-mongo.js'), path.join(getHomeDir(), 'cache', 'init-mongo.js'))
    }
}

export const cacheUpCommand = new Command()
    .name('up')
    .alias('start')
    .action(cacheUpAction)

export const cacheDownCommand = new Command()
    .name('down')
    .alias('stop')
    .action(cacheDownAction)

export const cacheInfoCommand = new Command()
    .name('info')
    .alias('i')
    .action(cacheInfoAction)

export const cacheInitCommand = new Command()
    .name('init')
    .action(cacheInitAction)

export const cacheImportCommand = new Command()
    .name('import')
    .description('Import a libs.json / misses.json folder into the local SQLite cache')
    .argument('<dir>', 'Folder holding the JSON files of the previous cache layout')
    .action(cacheImportAction)

export const cacheCommand = new Command()
    .name('cache')
    .action(cacheInfoAction)
    .addCommand(cacheUpCommand)
    .addCommand(cacheDownCommand)
    .addCommand(cacheInfoCommand)
    .addCommand(cacheInitCommand)
    .addCommand(cacheImportCommand)


