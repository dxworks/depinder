import {Command} from 'commander'
import chalk from 'chalk'
import {
    advisoryDir,
    defaultCacheDir,
    DEFAULT_MAX_AGE_HOURS,
    isStale,
    readManifest,
} from '../vuln-sources/github/cache'
import {downloadEcosystems, NoTokensError} from '../vuln-sources/github/download'
import {GITHUB_ECOSYSTEMS, resolveEcosystems} from '../vuln-sources/github/ecosystems'
import {ecosystemsInSboms} from '../vuln-sources/github/scan'
import {DEFAULT_TOKEN_FILE, loadTokens, maskToken, MAX_CONCURRENCY} from '../vuln-sources/github/tokens'
import {walkDir} from '../utils/utils'
import {log} from '../utils/logging'

/**
 * `depinder github-advisories download|status` — manual control of the advisory cache.
 *
 * The analysis refreshes what it needs on its own, so this command is for the two things it
 * cannot do: filling the cache before an offline run, and answering "what have I got, and how old
 * is it?" without starting an analysis.
 */

interface DownloadCommandOptions {
    ecosystems?: string
    sbom?: string[]
    tokenFile: string
    concurrency?: string
    force: boolean
    maxAge: string
}

/**
 * Which ecosystems to act on: the explicit list, or the ones present in the given SBOM folders,
 * or — with neither — every ecosystem GitHub offers.
 */
function chooseEcosystems(options: DownloadCommandOptions): string[] {
    if (options.ecosystems) return options.ecosystems.split(',')
    if (options.sbom?.length) {
        const files = options.sbom.flatMap(it => walkDir(it)).filter(it => it.endsWith('.cdx.json'))
        log.info(`Deriving ecosystems from ${files.length} SBOM file(s)`)
        return ecosystemsInSboms(files)
    }
    return GITHUB_ECOSYSTEMS.map(it => it.name)
}

export async function downloadAction(options: DownloadCommandOptions): Promise<void> {
    const cacheDir = defaultCacheDir()
    const requested = chooseEcosystems(options)
    const {resolved, unknown} = resolveEcosystems(requested)
    for (const name of unknown) log.warn(`Unknown ecosystem '${name}' — ignored`)
    if (resolved.length === 0) {
        log.error('No known ecosystems to download')
        return
    }

    const manifest = readManifest(cacheDir)
    const maxAge = Number(options.maxAge)
    const toDownload = options.force
        ? resolved
        : resolved.filter(it => isStale(manifest, it.name, maxAge))
    const skipped = resolved.filter(it => !toDownload.includes(it))
    for (const entry of skipped) {
        log.info(`${entry.name}: cached ${manifest.ecosystems[entry.name].downloadedAt}, younger than ${maxAge}h — skipping`)
    }
    if (toDownload.length === 0) {
        log.info('Everything requested is already cached and fresh. Use --force to download anyway.')
        return
    }

    try {
        const report = await downloadEcosystems(toDownload, {
            cacheDir,
            tokenFile: options.tokenFile,
            concurrency: options.concurrency ? Number(options.concurrency) : undefined,
        })
        for (const result of report.results) {
            const suffix = result.error ? chalk.red(` — INCOMPLETE: ${result.error}`) : ''
            log.info(`${result.ecosystem}: ${result.count} advisories, ${result.pages} page(s)${suffix}`)
        }
        log.info(`Cache: ${advisoryDir(cacheDir)}`)
    } catch (e: any) {
        if (e instanceof NoTokensError) log.error(e.message)
        else throw e
    }
}

export function statusAction(options: {tokenFile: string, maxAge: string}): void {
    const cacheDir = defaultCacheDir()
    const manifest = readManifest(cacheDir)
    const maxAge = Number(options.maxAge)

    const tokens = loadTokens(options.tokenFile)
    log.info(`Token file: ${options.tokenFile} — ${tokens.length} token(s), concurrency ${Math.max(1, Math.min(tokens.length, MAX_CONCURRENCY))}`)
    for (const token of tokens) log.info(`  ${maskToken(token)}`)

    log.info(`Advisory cache: ${advisoryDir(cacheDir)}`)
    const names = Object.keys(manifest.ecosystems).sort()
    if (names.length === 0) {
        log.info('  empty — run: depinder github-advisories download')
        return
    }
    for (const name of names) {
        const entry = manifest.ecosystems[name]
        const stale = isStale(manifest, name, maxAge)
        const state = entry.error ? chalk.red('INCOMPLETE') : stale ? chalk.yellow('stale') : chalk.green('fresh')
        log.info(`  ${name.padEnd(10)} ${String(entry.count).padStart(6)} advisories  ${entry.downloadedAt}  ${state}`)
        if (entry.error) log.info(`    ${entry.error}`)
    }
}

export const githubAdvisoriesDownloadCommand = new Command()
    .name('download')
    .description('Download GitHub reviewed security advisories into the local cache')
    .option('-e, --ecosystems <list>', 'Comma-separated ecosystems, in either GitHub or purl spelling (npm,gem,...)')
    .option('-s, --sbom <folders...>', 'Derive the ecosystems from the CycloneDX SBOMs in these folders')
    .option('--token-file <file>', 'Dotenv-style file holding GH_TOKEN_1, GH_TOKEN_2, ...', DEFAULT_TOKEN_FILE)
    .option('--concurrency <n>', `Parallel ecosystem workers (default: token count, max ${MAX_CONCURRENCY})`)
    .option('--max-age <hours>', 'Skip ecosystems cached more recently than this', String(DEFAULT_MAX_AGE_HOURS))
    .option('--force', 'Download even when the cache is fresh', false)
    .action(downloadAction)

export const githubAdvisoriesStatusCommand = new Command()
    .name('status')
    .description('Show the token pool and what the advisory cache holds')
    .option('--token-file <file>', 'Dotenv-style file holding GH_TOKEN_1, GH_TOKEN_2, ...', DEFAULT_TOKEN_FILE)
    .option('--max-age <hours>', 'Age at which a cached ecosystem counts as stale', String(DEFAULT_MAX_AGE_HOURS))
    .action(statusAction)

export const githubAdvisoriesCommand = new Command()
    .name('github-advisories')
    .description('Manage the local cache of GitHub security advisories')
    .addCommand(githubAdvisoriesDownloadCommand)
    .addCommand(githubAdvisoriesStatusCommand)
