import {Command} from 'commander'
import {execSync} from 'child_process'
import chalk from 'chalk'
import fs from 'fs'
import {getAssetFile, getHomeDir} from '../utils/utils'
import path from 'path'
import {log} from '../utils/logging'

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

export function cacheInfoAction(): void {
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

export const cacheCommand = new Command()
    .name('cache')
    .action(cacheInfoAction)
    .addCommand(cacheUpCommand)
    .addCommand(cacheDownCommand)
    .addCommand(cacheInfoCommand)
    .addCommand(cacheInitCommand)


