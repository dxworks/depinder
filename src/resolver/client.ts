import {log as defaultLog} from '../utils/logging'
import {count} from '../utils/profile'
import {ResolverConfig} from './config'

/**
 * The client for `POST {url}/resolve`.
 *
 * One call answers thousands of purls, which is the whole point: the per-package registrar chain
 * costs one upstream request per library, the resolver costs one request per 2000 of them. What it
 * cannot answer — a package it has never seen and did not fetch in time (`pending`), one the
 * registry does not have (`not_found`), an unparseable purl (`invalid`) — falls through to that
 * chain untouched, so this module never throws into the pipeline and never fails a run. A server
 * that is down, unauthorised or slow degrades the run to exactly today's behaviour.
 *
 * The answer is a stream (NDJSON, one package per line), not one JSON body. The server sends each
 * package once, as soon as its answer is final: fresh ones at once, unknown and stale ones as their
 * fetch lands, and whatever is still open when the deadline passes. That is what lets `analyse`
 * start its own per-package work while the server is still fetching, and it is why the client no
 * longer re-asks anything: every line is the last word on its package for this run.
 */

/**
 * `error` is the server's fifth status: it could not read the registry after three tries. Like
 * `not_found` and `invalid` it carries no package, so it falls through to the registrar chain —
 * but it has to be counted, or the summary line silently loses purls.
 *
 * `refreshing` is a package the server holds but has not confirmed within the `max_age` it was
 * sent, and could not refetch before the deadline: it comes with its last known facts, and those
 * are the answer for this run. `pending` is the same for a package the server had never seen.
 */
export type ResolveStatus = 'resolved' | 'refreshing' | 'not_found' | 'pending' | 'invalid' | 'error'

/** `flags` bit 0: the version is a prerelease. Nothing downstream reads it yet. */
export const VERSION_FLAG_PRERELEASE = 1
/** `flags` bit 1: the registry withdrew the version. `toLibraryInfo` drops those. */
export const VERSION_FLAG_YANKED = 2

/**
 * One version, as the wire carries it: a tuple rather than an object, because a package ships
 * every version it ever had (~137 on average) and the field names were most of the bytes.
 *
 * `released_at` is Unix epoch SECONDS, or `null` when the registry has no date. `flags` is a bit
 * set (see the constants above). The optional fourth element is this version's own license list,
 * present ONLY when it differs from the package-level `licenses` — a three-element tuple means
 * "same as the package", and an explicit `[]` means "this version has none although the package
 * does". `toLibraryInfo` expands both back into the `LibraryInfo` shape downstream already reads.
 */
export type CompactVersion =
    | [version: string, releasedAt: number | null, flags: number]
    | [version: string, releasedAt: number | null, flags: number, licenses: string[]]

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
    /** Every version the registry has, never a subset, ordered released_at asc (nulls first). */
    versions: CompactVersion[]
    /** The latest instant the registry itself vouched for these facts (a fetch, or a maven/cargo 304). */
    as_of: string | null
    source: string
    fetched_at: string
    /** The latest instant the server can show these facts matched the registry; what `max_age` is measured from. */
    confirmed_at?: string | null
}

export interface FeedRecord {
    mode: 'feed' | 'poll'
    lag_seconds: number | null
    cursor_time: string | null
}

/**
 * One item line: one package, with every purl the client sent that belongs to it, spelled exactly
 * as sent. `key` is the server's canonical package key, `null` for an `invalid` purl (which gets an
 * item of its own).
 */
interface ItemLine {
    key: string | null
    purls: string[]
    status: ResolveStatus
    package?: PackageRecord
    reason?: string
}

/** The last line, exactly once. A stream without it was cut short. */
interface TrailerLine {
    done: true
    feeds?: {[type: string]: FeedRecord}
}

/** What one purl came back as. `package` is present only for `resolved` and `refreshing`. */
export interface ResolvedEntry {
    status: ResolveStatus
    package?: PackageRecord
    reason?: string
}

/** Called once per purl, as the line that answers it arrives — long before `resolvePurls` returns. */
export type ItemHandler = (purl: string, entry: ResolvedEntry) => void

/** The server caps a request at 5000 purls; stay well under it so one slow chunk is not the run. */
export const CHUNK_SIZE = 2000
/** The server's own cap on `deadline_ms`; more would be a 400. */
export const MAX_DEADLINE_MS = 60_000
/**
 * How long a single HTTP call may take beyond the `deadline_ms` it sent before it is abandoned.
 *
 * This is a last resort, not a budget. The server enforces the deadline itself — at `deadline_ms`
 * it sends whatever is still open and the trailer — so the slack only has to cover the last flush
 * and the trip back. It used to be 60 s, when the server held every answer until the end and then
 * built one multi-megabyte body: a server restarted a moment earlier could take that long, and an
 * abort there cost more than the wait (the server built payloads nobody was reading, the retries
 * queued behind them and came back 500, and one 500 sends the whole run to the registries). With
 * the stream, lines are flushed as packages are read, so nothing large is left for the end. Thirty
 * seconds still covers a slow link, and `maxWaitMs` still ends the phase on time.
 */
const REQUEST_TIMEOUT_SLACK_MS = 30_000

type Logger = Pick<typeof defaultLog, 'info' | 'warn'>

/**
 * "The server is not answering" is a property of the run, not of one chunk: once a call has failed
 * its retry, every later chunk is skipped rather than paying the timeout again.
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

/**
 * A cheap stand-in for the server's package key: the purl without its `#subpath`, `?qualifiers`
 * and `@version`.
 *
 * The version `@` is the first one after the last `/`, not simply the last `@` in the string: an
 * npm scope may arrive unencoded (`pkg:npm/@types/node@20.1.0`) and a golang namespace can carry an
 * `@` of its own, but a name never contains a `/`. This is not the canonical key (no case folding,
 * no percent-decoding), and it does not need to be: it only decides which purls travel together. A
 * disagreement with the server costs one package sent twice in two chunks, nothing more.
 */
export function packageKeyOf(purl: string): string {
    let rest = purl
    const hash = rest.indexOf('#')
    if (hash >= 0) rest = rest.slice(0, hash)
    const query = rest.indexOf('?')
    if (query >= 0) rest = rest.slice(0, query)
    const at = rest.indexOf('@', rest.lastIndexOf('/') + 1)
    return at >= 0 ? rest.slice(0, at) : rest
}

/**
 * Splits the purls into chunks of at most `size`, never putting two versions of one package in two
 * chunks.
 *
 * The server answers per package, with every version it has, so a package split across chunks
 * would have its whole version list built and sent once per chunk. Groups are packed whole, in the
 * order they first appear; a single package with more purls than `size` gets a chunk to itself
 * (the server's own cap is well above `size`).
 */
export function packChunks(purls: string[], size: number): string[][] {
    const groups = new Map<string, string[]>()
    for (const purl of new Set(purls)) {
        const key = packageKeyOf(purl)
        const group = groups.get(key)
        if (group) group.push(purl)
        else groups.set(key, [purl])
    }
    const chunks: string[][] = []
    let current: string[] = []
    for (const group of groups.values()) {
        if (current.length > 0 && current.length + group.length > size) {
            chunks.push(current)
            current = []
        }
        current.push(...group)
    }
    if (current.length > 0) chunks.push(current)
    return chunks
}

class HttpStatusError extends Error {
    constructor(readonly status: number) {
        super(`HTTP ${status}`)
    }
}

/**
 * The `max_age` of one post: the seconds since the run's cutoff, worked out at the moment it is
 * sent.
 *
 * The server measures a duration from its own clock, and the run means an instant. Sending the
 * distance to that instant each time — floored, so nothing confirmed before it is ever accepted —
 * keeps a late chunk or a retry meaning the same thing as the first post. A fixed duration would
 * not: under `--refresh` it would be `0`, and a package the server refetched a second ago would be
 * stale again for the next chunk that names it.
 */
export function maxAgeFor(freshAfterMs: number, now = Date.now()): number {
    return Math.max(0, Math.floor((now - freshAfterMs) / 1000))
}

/**
 * Every complete line of an NDJSON body, as it arrives.
 *
 * A read hands over whatever bytes the network delivered, which is rarely a whole number of lines
 * (or even of UTF-8 characters): the decoder keeps a split character for the next read
 * (`stream: true`), and the buffer keeps a split line. Blank lines are skipped, which also lets a
 * server send a bare `\n` as a keepalive. Undici has already undone any br/gzip encoding.
 */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
        for (;;) {
            const {done, value} = await reader.read()
            buffer += done ? decoder.decode() : decoder.decode(value, {stream: true})
            let newline: number
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim()
                buffer = buffer.slice(newline + 1)
                if (line) yield line
            }
            if (done) break
        }
        const last = buffer.trim()
        if (last) yield last
    } finally {
        // A no-op after a clean end; after the trailer or a bad line it lets undici drop the rest.
        await reader.cancel().catch(() => undefined)
    }
}

/** How one post ended. `items` counts the item lines that arrived, whatever came after them. */
type PostOutcome =
    | {kind: 'done', items: number, feeds?: {[type: string]: FeedRecord}}
    | {kind: 'http', items: 0, status: number}
    | {kind: 'broken', items: number, reason: string}

/**
 * One post, read to its end.
 *
 * Never throws: a status, a network error, a malformed line and a body that stops before the
 * trailer all come back as an outcome, with every item that did arrive already handed to `onLine`.
 * Each line is a complete, final fact about its package, so a stream cut short is not discarded —
 * only the purls nobody answered for are worth asking again.
 */
async function postOnce(
    config: ResolverConfig,
    purls: string[],
    deadlineMs: number,
    onLine: (item: ItemLine) => void
): Promise<PostOutcome> {
    count('resolver:request')
    const body: {purls: string[], max_age?: number, deadline_ms: number} = {purls, deadline_ms: deadlineMs}
    if (config.freshAfterMs !== undefined) body.max_age = maxAgeFor(config.freshAfterMs)
    let items = 0
    try {
        const response = await fetch(`${config.url}/resolve`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${config.token}`,
                'Content-Type': 'application/json',
                // Undici decodes br but only asks for `gzip, deflate` on its own, and br is
                // markedly smaller on this payload (5.8x against gzip's 3.9x). Asked for
                // explicitly, it is still decoded transparently, flush by flush.
                'Accept-Encoding': 'br, gzip',
            },
            body: JSON.stringify(body),
            signal: typeof AbortSignal?.timeout === 'function'
                ? AbortSignal.timeout(deadlineMs + REQUEST_TIMEOUT_SLACK_MS)
                : undefined,
        })
        if (!response.ok) {
            // Nothing else will be read from it; let undici close the connection.
            await response.body?.cancel().catch(() => undefined)
            throw new HttpStatusError(response.status)
        }
        if (!response.body) return {kind: 'broken', items, reason: 'empty response body'}
        for await (const line of lines(response.body)) {
            const parsed = JSON.parse(line) as ItemLine | TrailerLine
            if ('done' in parsed && parsed.done) return {kind: 'done', items, feeds: parsed.feeds}
            items++
            onLine(parsed as ItemLine)
        }
        return {kind: 'broken', items, reason: 'stream ended without its last line'}
    } catch (e: any) {
        if (e instanceof HttpStatusError) return {kind: 'http', items: 0, status: e.status}
        return {kind: 'broken', items, reason: e?.message ?? String(e)}
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
 * Asks the resolver about every purl, and returns what it answered.
 *
 * Each purl's answer is also handed to `onItem` the moment its line arrives, so the caller can
 * start on it while the rest of the stream is still coming. The returned map holds the same
 * answers, for the counts.
 *
 * A purl missing from the returned map is not an error: it means the server never answered for it
 * (unavailable, or cut off twice), and the caller must fall back. So does a `pending` one.
 */
export async function resolvePurls(
    config: ResolverConfig,
    purls: string[],
    log: Logger = defaultLog,
    onItem?: ItemHandler
): Promise<Map<string, ResolvedEntry>> {
    const entries = new Map<string, ResolvedEntry>()
    if (purls.length === 0 || unavailable) return entries

    /**
     * One deadline for the whole ask, fixed before the first post. Every chunk is posted at once,
     * so every chunk gets all of it, and its cold packages are urgent on the server for the whole
     * wait.
     */
    const deadline = Date.now() + config.maxWaitMs
    /**
     * What is left of that budget, as the server's `deadline_ms`: worked out per post, so a chunk
     * that waited for a slot under `DEPINDER_RESOLVER_CONCURRENCY` does not get the whole budget
     * again. `0` is valid and means "send what you have now", so a late chunk still gets every
     * fresh answer.
     */
    const deadlineMs = () => Math.min(MAX_DEADLINE_MS, Math.max(0, deadline - Date.now()))
    let feedsLogged = false

    /**
     * One chunk, with the single retry the design allows.
     *
     * A network error or a 5xx is transient, so it is worth one more attempt. A 4xx is not — a bad
     * token or a malformed body will answer the same way forever — so it goes straight to
     * unavailable. A stream that breaks off keeps every line it delivered, and the retry asks only
     * for the purls no line answered; a stream that ended cleanly but skipped a purl is treated the
     * same way. A second failure of either kind makes the resolver unavailable for the run.
     */
    const askChunk = async (chunk: string[]): Promise<void> => {
        let missing = chunk
        for (let attempt = 0; attempt < 2; attempt++) {
            const asked = new Set(missing)
            const outcome = await postOnce(config, missing, deadlineMs(), item => {
                const entry: ResolvedEntry = {
                    status: item.status,
                    package: item.status === 'resolved' || item.status === 'refreshing' ? item.package : undefined,
                    reason: item.reason,
                }
                // Keyed on the purl as sent, which the server echoes verbatim; anything it names
                // that this post did not ask for, or answers twice, is ignored.
                for (const purl of item.purls ?? []) {
                    if (!asked.has(purl) || entries.has(purl)) continue
                    entries.set(purl, entry)
                    onItem?.(purl, entry)
                }
            })
            if (outcome.kind === 'done' && !feedsLogged) {
                feedsLogged = true
                logFeeds(outcome.feeds, log)
            }
            missing = missing.filter(purl => !entries.has(purl))
            if (outcome.kind === 'done' && missing.length === 0) return

            if (outcome.kind === 'http' && outcome.status < 500) {
                markUnavailable(log, `HTTP ${outcome.status}`)
                return
            }
            const reason = outcome.kind === 'http' ? `HTTP ${outcome.status}`
                : outcome.kind === 'broken' ? outcome.reason
                    : `${missing.length} purl(s) missing from a complete answer`
            if (attempt === 1) {
                markUnavailable(log, reason)
                return
            }
            log.warn(outcome.items > 0
                ? `Resolver stream broke off (${reason}) after ${outcome.items} package(s); `
                    + `asking again for the ${missing.length} purl(s) it did not answer, retrying once`
                : `Resolver request failed (${reason}), retrying once`)
        }
    }

    /**
     * Posts the chunks — all of them at once, unless `config.chunkConcurrency` caps it.
     *
     * The chunks are independent questions — the server answers each from its own database and its
     * own upstream fetches — so waiting for one before asking the next spent the run in series for
     * nothing: six chunks took 22-30 s one after another and 12-14 s side by side. Posting only a
     * few at a time was the same mistake on a smaller scale: a chunk that waited for a slot went out
     * with what was left of the deadline, and its cold packages were never urgent on the server.
     *
     * `unavailable` is re-read before each chunk is taken rather than once at the top. With every
     * chunk posted together that changes nothing — they are all in flight before any answers —
     * but under a cap it keeps the "stop asking" semantics: a chunk already in flight when another
     * one turns the resolver off runs to its end and its answer is kept — throwing away a response
     * that has already been paid for helps nobody — and nothing new is started after that.
     */
    const chunks = packChunks(purls, CHUNK_SIZE)
    let next = 0
    await Promise.all(Array.from(
        {length: Math.min(Math.max(1, config.chunkConcurrency), chunks.length)},
        async () => {
            while (next < chunks.length) {
                if (unavailable) return
                await askChunk(chunks[next++])
            }
        }
    ))

    const resolved = tally(entries, 'resolved')
    const refreshing = tally(entries, 'refreshing')
    const stillPending = tally(entries, 'pending')
    const notFound = tally(entries, 'not_found')
    const invalid = tally(entries, 'invalid')
    const errored = tally(entries, 'error')
    count('resolver:resolved', resolved)
    count('resolver:refreshing', refreshing)
    count('resolver:pending', stillPending)
    count('resolver:not-found', notFound)
    count('resolver:error', errored)
    log.info(`Resolver answered for ${purls.length} purl(s): ${resolved} resolved, `
        + `${refreshing ? `${refreshing} refreshing (last known facts), ` : ''}${stillPending} pending, `
        + `${notFound} not found${invalid ? `, ${invalid} invalid` : ''}`
        + `${errored ? `, ${errored} error` : ''}`
        + `${entries.size < purls.length ? `, ${purls.length - entries.size} unanswered` : ''}`)
    return entries
}
