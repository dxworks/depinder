import {GithubAdvisory} from './advisory'
import {AdvisoryClient, HttpFetch} from './client'
import {defaultCacheDir, DEFAULT_MAX_AGE_HOURS, staleEcosystems, writeEcosystem} from './cache'
import {GithubEcosystem, resolveEcosystems} from './ecosystems'
import {loadTokens, MAX_CONCURRENCY, TokenPool, TokenUsage} from './tokens'
import {log} from '../../utils/logging'

/**
 * Downloading advisories into the cache.
 *
 * One worker per ecosystem, all workers sharing one token pool. The unit of parallelism is the
 * ecosystem rather than the page because pagination is by opaque cursor: page N+1's URL is only
 * known once page N has arrived, so a single ecosystem cannot be fetched in parallel with itself.
 */

export interface DownloadOptions {
    cacheDir?: string
    tokenFile?: string
    /** Defaults to the pool size, capped at MAX_CONCURRENCY. */
    concurrency?: number
    fetch?: HttpFetch
    sleep?: (ms: number) => Promise<void>
    maxAttempts?: number
    baseUrl?: string
    safetyMargin?: number
}

export interface EcosystemDownloadResult {
    ecosystem: string
    count: number
    pages: number
    error?: string
}

export interface DownloadReport {
    results: EcosystemDownloadResult[]
    tokenUsage: TokenUsage[]
    tokens: number
    concurrency: number
}

export class NoTokensError extends Error {
    constructor(tokenFile: string) {
        super(`No GitHub tokens found. Put GH_TOKEN_1=..., GH_TOKEN_2=... (or a single GH_TOKEN) in ${tokenFile},`
            + ' or export them, then re-run.')
        this.name = 'NoTokensError'
    }
}

/**
 * Downloads the given ecosystems into the cache, one JSON file each.
 *
 * A failure part-way through an ecosystem still writes what arrived, with the error recorded in
 * the manifest — a partial file is more useful than none, and `isStale` treats it as stale so the
 * next run retries it. One ecosystem failing never stops the others.
 */
export async function downloadEcosystems(
    ecosystems: GithubEcosystem[],
    options: DownloadOptions = {}
): Promise<DownloadReport> {
    const cacheDir = options.cacheDir ?? defaultCacheDir()
    const tokenFile = options.tokenFile ?? '.github-tokens'
    const tokens = loadTokens(tokenFile)
    if (tokens.length === 0) throw new NoTokensError(tokenFile)

    const pool = new TokenPool(tokens, {safetyMargin: options.safetyMargin})
    const client = new AdvisoryClient({
        pool,
        fetch: options.fetch,
        sleep: options.sleep,
        maxAttempts: options.maxAttempts,
        baseUrl: options.baseUrl,
    })
    const concurrency = Math.max(1, Math.min(options.concurrency ?? pool.concurrency, MAX_CONCURRENCY))

    log.info(`Downloading GitHub advisories for ${ecosystems.map(it => it.name).join(', ')}`
        + ` with ${tokens.length} token(s) at concurrency ${concurrency}`)

    const results: EcosystemDownloadResult[] = []
    let next = 0
    await Promise.all(Array.from({length: Math.min(concurrency, ecosystems.length)}, async () => {
        while (next < ecosystems.length) {
            const ecosystem = ecosystems[next++]
            results.push(await downloadOne(client, cacheDir, ecosystem.name))
        }
    }))

    const usage = pool.usage()
    for (const entry of usage) {
        log.info(`Token ${entry.token}: ${entry.requests} request(s), ${entry.remaining ?? '?'} remaining,`
            + ` parked ${entry.parked} time(s)`)
    }
    return {results, tokenUsage: usage, tokens: tokens.length, concurrency}
}

async function downloadOne(client: AdvisoryClient, cacheDir: string, ecosystem: string): Promise<EcosystemDownloadResult> {
    const advisories: GithubAdvisory[] = []
    let pages = 0
    let lastPage = client.firstPageUrl(ecosystem)
    try {
        for await (const page of client.pages(ecosystem)) {
            advisories.push(...page.advisories)
            pages++
            if (page.nextUrl) lastPage = page.nextUrl
        }
        writeEcosystem(cacheDir, ecosystem, advisories, {downloadedAt: new Date().toISOString(), lastPage})
        log.info(`${ecosystem}: ${advisories.length} advisories over ${pages} page(s)`)
        return {ecosystem, count: advisories.length, pages}
    } catch (e: any) {
        const error = e?.message ?? String(e)
        writeEcosystem(cacheDir, ecosystem, advisories, {downloadedAt: new Date().toISOString(), lastPage, error})
        log.warn(`${ecosystem}: download failed after ${advisories.length} advisories — ${error}`)
        return {ecosystem, count: advisories.length, pages, error}
    }
}

/**
 * Refreshes only what an analysis actually needs: the ecosystems present in the SBOMs, minus the
 * ones already on disk and younger than `maxAgeHours`.
 *
 * Returns undefined when nothing needed downloading — the common case on a second run the same
 * day, and the reason this is cheap enough to call unconditionally.
 */
export async function refreshEcosystems(
    ecosystemNames: string[],
    maxAgeHours: number = DEFAULT_MAX_AGE_HOURS,
    options: DownloadOptions = {}
): Promise<DownloadReport | undefined> {
    const cacheDir = options.cacheDir ?? defaultCacheDir()
    const stale = staleEcosystems(cacheDir, ecosystemNames, maxAgeHours)
    if (stale.length === 0) return undefined
    const {resolved} = resolveEcosystems(stale)
    if (resolved.length === 0) return undefined
    return downloadEcosystems(resolved, options)
}
