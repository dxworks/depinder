import {log as defaultLog} from '../utils/logging'
import {count} from '../utils/profile'
import {ResolverConfig} from './config'

/**
 * The client for `POST {url}/resolve`.
 *
 * One call answers thousands of purls, which is the whole point: the per-package registrar chain
 * costs one upstream request per library, the resolver costs one request per 2000 of them. What it
 * cannot answer — a package it has never seen and is still fetching (`pending`), one the registry
 * does not have (`not_found`), an unparseable purl (`invalid`) — falls through to that chain
 * untouched, so this module never throws into the pipeline and never fails a run. A server that is
 * down, unauthorised or slow degrades the run to exactly today's behaviour.
 */

export type ResolveStatus = 'resolved' | 'not_found' | 'pending' | 'invalid'

export interface ResolvedVersionRecord {
    version: string
    released_at: string | null
    licenses: string[]
    found: boolean
}

export interface PackageVersionRecord {
    version: string
    released_at: string | null
    licenses: string[]
    prerelease: boolean
    yanked: boolean
}

export interface PackageRecord {
    type: string
    namespace: string | null
    name: string
    description: string | null
    homepage_url: string | null
    repo_url: string | null
    licenses: string[]
    latest: {version: string, released_at: string | null} | null
    latest_prerelease: {version: string, released_at: string | null} | null
    versions: PackageVersionRecord[]
    /** Freshness: the feed cursor time (feed mode) or the last successful poll (poll mode). */
    as_of: string | null
    source: string
    fetched_at: string
}

export interface FeedRecord {
    mode: 'feed' | 'poll'
    lag_seconds: number | null
    cursor_time: string | null
}

interface ResolveResult {
    purl: string
    package_key: string
    status: ResolveStatus
    reason?: string
    requested_version: ResolvedVersionRecord | null
}

interface ResolveResponse {
    results?: ResolveResult[]
    packages?: {[packageKey: string]: PackageRecord}
    feeds?: {[type: string]: FeedRecord}
}

/** What one purl came back as. `package` is present only for `resolved`. */
export interface ResolvedEntry {
    status: ResolveStatus
    package?: PackageRecord
    requestedVersion?: ResolvedVersionRecord
    reason?: string
}

/** The server caps a request at 5000 purls; stay well under it so one slow chunk is not the run. */
export const CHUNK_SIZE = 2000
/** Sent on the first ask only: the server holds the connection while it fills what it can. */
export const FIRST_WAIT_MS = 15_000
/** How often still-`pending` purls are asked for again. */
export const RE_ASK_INTERVAL_MS = 3000
/** How long a single HTTP call may take beyond the server-side wait before it is abandoned. */
const REQUEST_TIMEOUT_SLACK_MS = 20_000

type Logger = Pick<typeof defaultLog, 'info' | 'warn'>

/**
 * "The server is not answering" is a property of the run, not of one chunk: once a call has failed
 * its retry, every later chunk and every re-ask is skipped rather than paying the timeout again.
 */
let unavailable = false
let warned = false

/** For tests, and for a second `runAnalysis` in the same process. */
export function resetResolverClient(): void {
    unavailable = false
    warned = false
}

export function resolverUnavailable(): boolean {
    return unavailable
}

function markUnavailable(log: Logger, reason: string): void {
    unavailable = true
    if (warned) return
    warned = true
    log.warn(`Resolver unavailable (${reason}); falling back to the per-package registries for the rest of this run`)
}

export function chunked<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
    return chunks
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class HttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`)
    }
}

async function postOnce(config: ResolverConfig, purls: string[], waitMs: number): Promise<ResolveResponse> {
    count('resolver:request')
    const body: {purls: string[], wait_ms?: number} = {purls}
    if (waitMs > 0) body.wait_ms = waitMs
    const response = await fetch(`${config.url}/resolve`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: typeof AbortSignal?.timeout === 'function'
            ? AbortSignal.timeout(waitMs + REQUEST_TIMEOUT_SLACK_MS)
            : undefined,
    })
    if (!response.ok) throw new HttpStatusError(response.status)
    return await response.json() as ResolveResponse
}

/**
 * One chunk, with the single retry the design allows.
 *
 * A network error or a 5xx is transient, so it is worth one more attempt. A 4xx is not — a bad
 * token or a malformed body will answer the same way forever — so it goes straight to unavailable.
 * Either way the caller gets `undefined` and keeps whatever it already has.
 */
async function post(config: ResolverConfig, purls: string[], waitMs: number, log: Logger): Promise<ResolveResponse | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await postOnce(config, purls, waitMs)
        } catch (e: any) {
            const status = e instanceof HttpStatusError ? e.status : undefined
            const retryable = status === undefined || status >= 500
            if (!retryable) {
                markUnavailable(log, `HTTP ${status}`)
                return undefined
            }
            if (attempt === 1) {
                markUnavailable(log, status ? `HTTP ${status}` : (e?.message ?? String(e)))
                return undefined
            }
            log.warn(`Resolver request failed (${status ? `HTTP ${status}` : e?.message ?? e}), retrying once`)
        }
    }
    return undefined
}

function absorb(response: ResolveResponse, into: Map<string, ResolvedEntry>): void {
    const packages = response.packages ?? {}
    for (const result of response.results ?? []) {
        // Keyed on the purl as sent: the server canonicalises `package_key`, so the echoed `purl`
        // is the only field guaranteed to match what the caller asked for.
        into.set(result.purl, {
            status: result.status,
            package: result.status === 'resolved' ? packages[result.package_key] : undefined,
            requestedVersion: result.requested_version ?? undefined,
            reason: result.reason,
        })
    }
}

function logFeeds(feeds: {[type: string]: FeedRecord} | undefined, log: Logger): void {
    if (!feeds || Object.keys(feeds).length === 0) return
    const described = Object.entries(feeds).map(([type, feed]) => {
        const lag = feed.lag_seconds === null || feed.lag_seconds === undefined
            ? 'unknown'
            : `${Math.round(feed.lag_seconds)}s`
        return `${type} ${feed.mode} lag ${lag}`
    })
    log.info(`Resolver freshness: ${described.join(', ')}`)
}

function tally(entries: Map<string, ResolvedEntry>, status: ResolveStatus): number {
    let n = 0
    for (const entry of entries.values()) if (entry.status === status) n++
    return n
}

/**
 * Asks the resolver about every purl, and returns what it knew in time.
 *
 * A purl missing from the returned map is not an error: it means the server never answered for it
 * (unavailable, or still `pending` when the deadline passed), and the caller must fall back.
 */
export async function resolvePurls(
    config: ResolverConfig,
    purls: string[],
    log: Logger = defaultLog,
    timing: {reAskIntervalMs?: number} = {}
): Promise<Map<string, ResolvedEntry>> {
    const entries = new Map<string, ResolvedEntry>()
    if (purls.length === 0 || unavailable) return entries

    const deadline = Date.now() + config.maxWaitMs
    const reAskIntervalMs = timing.reAskIntervalMs ?? RE_ASK_INTERVAL_MS
    let feedsLogged = false

    const ask = async (batch: string[], waitMs: number): Promise<void> => {
        for (const chunk of chunked(batch, CHUNK_SIZE)) {
            if (unavailable) return
            const response = await post(config, chunk, waitMs, log)
            if (!response) return
            if (!feedsLogged) {
                feedsLogged = true
                logFeeds(response.feeds, log)
            }
            absorb(response, entries)
        }
    }

    await ask(purls, FIRST_WAIT_MS)

    // Re-ask only what is still being filled. Everything else is final: `not_found` and `invalid`
    // will not change within a run, and `resolved` is already in hand.
    let pending = purls.filter(purl => entries.get(purl)?.status === 'pending')
    while (pending.length > 0 && !unavailable && Date.now() + reAskIntervalMs < deadline) {
        await delay(reAskIntervalMs)
        await ask(pending, 0)
        pending = pending.filter(purl => entries.get(purl)?.status === 'pending')
    }

    const resolved = tally(entries, 'resolved')
    const stillPending = tally(entries, 'pending')
    const notFound = tally(entries, 'not_found')
    const invalid = tally(entries, 'invalid')
    count('resolver:resolved', resolved)
    count('resolver:pending', stillPending)
    count('resolver:not-found', notFound)
    log.info(`Resolver answered for ${purls.length} purl(s): ${resolved} resolved, ${stillPending} pending, `
        + `${notFound} not found${invalid ? `, ${invalid} invalid` : ''}`
        + `${entries.size < purls.length ? `, ${purls.length - entries.size} unanswered` : ''}`)
    return entries
}
