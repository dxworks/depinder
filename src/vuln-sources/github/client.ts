import https from 'https'
import {GithubAdvisory} from './advisory'
import {TokenPool} from './tokens'
import {log} from '../../utils/logging'

/**
 * The `GET /advisories` client: one page at a time, cursor pagination, tokens drawn from the pool.
 *
 * Everything that touches the network goes through the injected `HttpFetch`, which is what makes
 * this file unit-testable without a token or a socket. The default implementation is at the
 * bottom and is the only place `https` is used.
 */

export interface HttpResponse {
    status: number
    /** Lowercase header names. */
    headers: {[name: string]: string | undefined}
    body: string
}

export type HttpFetch = (url: string, headers: {[name: string]: string}) => Promise<HttpResponse>

export const GITHUB_API_BASE = 'https://api.github.com'
export const PAGE_SIZE = 100

export interface AdvisoryPage {
    advisories: GithubAdvisory[]
    /** The URL of the next page, from the `Link` header, or undefined on the last page. */
    nextUrl?: string
}

export interface ClientOptions {
    pool: TokenPool
    fetch?: HttpFetch
    /** Attempts per page, including the first. */
    maxAttempts?: number
    sleep?: (ms: number) => Promise<void>
    baseUrl?: string
}

/**
 * `Link: <https://api.github.com/advisories?after=Y3Vyc29yOnYyOpK5...>; rel="next", <...>; rel="prev"`
 *
 * The advisories endpoint pages by opaque cursor, not page number, so the `next` URL must be
 * followed verbatim — reconstructing it from a page counter silently returns page 1 forever.
 */
export function nextLink(linkHeader: string | undefined): string | undefined {
    if (!linkHeader) return undefined
    for (const part of linkHeader.split(',')) {
        const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/.exec(part)
        if (match) return match[1]
    }
    return undefined
}

const RETRYABLE = (status: number): boolean => status === 403 || status === 429 || status >= 500

/** Exponential backoff with full jitter, so parallel workers do not retry in lockstep. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
    const ceiling = Math.min(60_000, 1000 * 2 ** attempt)
    return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class AdvisoryClient {
    private readonly pool: TokenPool
    private readonly fetch: HttpFetch
    private readonly maxAttempts: number
    private readonly sleep: (ms: number) => Promise<void>
    private readonly baseUrl: string

    constructor(options: ClientOptions) {
        this.pool = options.pool
        this.fetch = options.fetch ?? nodeHttpsFetch
        this.maxAttempts = options.maxAttempts ?? 5
        this.sleep = options.sleep ?? realSleep
        this.baseUrl = options.baseUrl ?? GITHUB_API_BASE
    }

    firstPageUrl(ecosystem: string): string {
        return `${this.baseUrl}/advisories?type=reviewed&ecosystem=${encodeURIComponent(ecosystem)}&per_page=${PAGE_SIZE}`
    }

    /**
     * One page, retried on 403/429/5xx. A token that hits a rate-limit response is parked for the
     * backoff interval as well, so the retry lands on a different token whenever the pool has one.
     */
    async getPage(url: string): Promise<AdvisoryPage> {
        let lastError = ''
        for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
            const token = await this.pool.acquire()
            let response: HttpResponse
            try {
                response = await this.fetch(url, {
                    accept: 'application/vnd.github+json',
                    authorization: `Bearer ${token}`,
                    'x-github-api-version': '2022-11-28',
                    'user-agent': 'depinder-github-advisory-source',
                })
            } catch (e: any) {
                lastError = `network error: ${e?.message ?? e}`
                this.pool.release(token)
                await this.sleep(backoffDelay(attempt))
                continue
            }
            this.pool.observe(token, response.headers)
            this.pool.release(token)

            if (response.status === 200) {
                return {
                    advisories: JSON.parse(response.body) as GithubAdvisory[],
                    nextUrl: nextLink(response.headers.link),
                }
            }

            lastError = `HTTP ${response.status}: ${response.body.slice(0, 200)}`
            if (!RETRYABLE(response.status)) throw new Error(`${url} -> ${lastError}`)

            // `retry-after` is authoritative when present (secondary rate limits); otherwise back
            // off. Either way park the token so the retry prefers a different one.
            const retryAfter = Number(response.headers['retry-after'])
            const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : backoffDelay(attempt)
            this.pool.parkFor(token, delay)
            log.warn(`GitHub advisories ${lastError} — retrying in ${delay}ms (attempt ${attempt + 1}/${this.maxAttempts})`)
            await this.sleep(delay)
        }
        throw new Error(`Giving up on ${url} after ${this.maxAttempts} attempts — ${lastError}`)
    }

    /** Every reviewed advisory for one ecosystem, page by page. */
    async* pages(ecosystem: string): AsyncGenerator<AdvisoryPage> {
        let url: string | undefined = this.firstPageUrl(ecosystem)
        while (url) {
            const page: AdvisoryPage = await this.getPage(url)
            yield page
            url = page.nextUrl
        }
    }
}

/** The only place a real socket is opened. Follows no redirects; the API does not issue any. */
export const nodeHttpsFetch: HttpFetch = (url, headers) => new Promise((resolve, reject) => {
    const request = https.get(url, {headers}, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolve({
            status: response.statusCode ?? 0,
            headers: response.headers as {[name: string]: string | undefined},
            body: Buffer.concat(chunks).toString('utf8'),
        }))
    })
    request.on('error', reject)
    request.setTimeout(60_000, () => request.destroy(new Error('timed out after 60s')))
})
