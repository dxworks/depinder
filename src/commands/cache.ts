import {Command} from 'commander'
import chalk from 'chalk'
import path from 'path'
import {log} from '../utils/logging'
import {defaultCacheDbFile, sharedCacheDb} from '../cache/sqlite-cache'
import {CacheMaxAgeOptions, cacheMaxAgeSeconds, formatDuration, freshnessCutoffMs} from '../cache/max-age'

function formatBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
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
    // Imported rows carry libs.json's mtime as their age, so an old file imports as expired.
    if (counts.libs > 0) log.info('  Imported libraries are as old as libs.json: those past the cache max age are fetched again on the next analyse')
}

/** The local SQLite cache: where it is and what it holds. */
export function cacheInfoAction(options: CacheMaxAgeOptions = {}): void {
    const db = sharedCacheDb()
    const stats = db.stats()
    const maxAgeSeconds = cacheMaxAgeSeconds(options)
    const expired = db.countLibsUpdatedBefore(freshnessCutoffMs(maxAgeSeconds))
    log.info(`Local cache: ${chalk.yellow(stats.file)} (${formatBytes(stats.bytes)})`)
    log.info(`  ${stats.libs} libraries (${stats.libs - expired} fresh, ${expired} expired at max age `
        + `${formatDuration(maxAgeSeconds)}), ${stats.misses} misses`)
}

const maxAgeOption = ['--cache-max-age <duration>',
    'Count libraries older than this as expired: <n>[s|m|h|d]; DEPINDER_CACHE_MAX_AGE when unset, else 1d'] as const

export const cacheInfoCommand = new Command()
    .name('info')
    .alias('i')
    .description('Show where the local SQLite cache is and what it holds')
    .option(...maxAgeOption)
    .action(cacheInfoAction)

export const cacheImportCommand = new Command()
    .name('import')
    .description('Import a libs.json / misses.json folder into the local SQLite cache')
    .argument('<dir>', 'Folder holding the JSON files of the previous cache layout')
    .action(cacheImportAction)

export const cacheCommand = new Command()
    .name('cache')
    .option(...maxAgeOption)
    .action(cacheInfoAction)
    .addCommand(cacheInfoCommand)
    .addCommand(cacheImportCommand)
