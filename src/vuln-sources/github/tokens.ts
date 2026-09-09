import fs from 'fs'
import path from 'path'

/**
 * The token pool.
 *
 * Downloading every reviewed advisory for an ecosystem is thousands of REST calls, and one token
 * buys 5,000 requests an hour. So depinder reads a *pool* of tokens and spends them in rotation,
 * watching `x-ratelimit-remaining` on every response and parking a token before it is exhausted
 * rather than after — a 403 from a spent token costs a round trip and tells us nothing new.
 *
 * A token is a resource with exactly one in-flight request at a time. That is what bounds
 * concurrency: `acquire()` hands out the least-recently-used unparked token and blocks when there
 * is none, so the download never has more requests in flight than it has tokens, and never more
 * than the caller's own cap either.
 */

export const DEFAULT_TOKEN_FILE = '.github-tokens'

/**
 * Stop using a token while it still has this many requests left in the window.
 *
 * The margin exists because the counter we read is one response old and several workers share the
 * window: without it, the last few requests of a window race each other into 403s.
 */
export const DEFAULT_SAFETY_MARGIN = 25

/** Never open more than this many connections to api.github.com, however many tokens exist. */
export const MAX_CONCURRENCY = 4

// ---------------------------------------------------------------------------
// Reading the token file
// ---------------------------------------------------------------------------

/**
 * Parses a dotenv-style file: `KEY=value` per line, `#` comments, blank lines, an optional
 * `export ` prefix, and optional single or double quotes around the value. Nothing is exported to
 * the process environment — the tokens stay in this module.
 */
export function parseTokenFile(content: string): Map<string, string> {
    const values = new Map<string, string>()
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('#')) continue
        const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line
        const equals = withoutExport.indexOf('=')
        if (equals <= 0) continue
        const key = withoutExport.slice(0, equals).trim()
        let value = withoutExport.slice(equals + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
            value = value.slice(1, -1)
        }
        if (key && value) values.set(key, value)
    }
    return values
}

/**
 * Collects the pool from `GH_TOKEN_1`, `GH_TOKEN_2`, ... (contiguous from 1 — the first gap ends
 * the pool, so a commented-out `GH_TOKEN_3` cannot silently hide `GH_TOKEN_4`), plus a bare
 * `GH_TOKEN` treated as a pool of one. The file wins over the environment for the same key, so a
 * token file can override an exported token without unsetting it.
 *
 * Both sources are optional: an absent file is not an error, it just leaves the environment to
 * supply the pool, and an empty pool is the caller's problem to report.
 */
export function loadTokens(tokenFile: string = DEFAULT_TOKEN_FILE, env: NodeJS.ProcessEnv = process.env): string[] {
    const resolved = path.resolve(process.cwd(), tokenFile)
    const fromFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? parseTokenFile(fs.readFileSync(resolved, 'utf8'))
        : new Map<string, string>()

    const valueOf = (key: string): string | undefined => fromFile.get(key) ?? env[key] ?? undefined

    const tokens: string[] = []
    for (let index = 1; ; index++) {
        const token = valueOf(`GH_TOKEN_${index}`)
        if (!token) break
        if (!tokens.includes(token)) tokens.push(token)
    }
    const single = valueOf('GH_TOKEN')
    if (single && !tokens.includes(single)) tokens.push(single)
    return tokens
}

/** Never log a token. Four leading characters are enough to tell two tokens apart in a report. */
export function maskToken(token: string): string {
    return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export interface TokenUsage {
    token: string
    requests: number
    remaining?: number
    /** Number of times this token was parked for the rest of a rate-limit window. */
    parked: number
}

interface PooledToken {
    token: string
    requests: number
    parked: number
    remaining?: number
    /** Epoch milliseconds; the token is unusable until then. */
    parkedUntil: number
    /**
     * A monotonic issue counter, not a timestamp: requests complete faster than `Date.now()`
     * ticks, and a tie there would collapse the rotation onto the first token.
     */
    lastIssued: number
    busy: boolean
}

export interface TokenPoolOptions {
    safetyMargin?: number
    /** Injected in tests so parking does not really take an hour. */
    now?: () => number
    sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class TokenPool {
    private readonly tokens: PooledToken[]
    private readonly safetyMargin: number
    private readonly now: () => number
    private readonly sleep: (ms: number) => Promise<void>
    private issued = 0

    constructor(tokens: string[], options: TokenPoolOptions = {}) {
        this.tokens = tokens.map(token => ({
            token, requests: 0, parked: 0, parkedUntil: 0, lastIssued: 0, busy: false,
        }))
        this.safetyMargin = options.safetyMargin ?? DEFAULT_SAFETY_MARGIN
        this.now = options.now ?? Date.now
        this.sleep = options.sleep ?? realSleep
    }

    get size(): number {
        return this.tokens.length
    }

    /** The download concurrency this pool supports: one request per token, capped. */
    get concurrency(): number {
        return Math.max(1, Math.min(this.tokens.length, MAX_CONCURRENCY))
    }

    /**
     * The least-recently-used free token, waiting if every token is busy or parked. Round-robin
     * falls out of "least recently used": with all tokens free, the one used longest ago is next.
     */
    async acquire(): Promise<string> {
        for (;;) {
            const now = this.now()
            const free = this.tokens.filter(it => !it.busy && it.parkedUntil <= now)
            if (free.length > 0) {
                const chosen = free.reduce((a, b) => (a.lastIssued <= b.lastIssued ? a : b))
                chosen.busy = true
                chosen.lastIssued = ++this.issued
                chosen.requests++
                return chosen.token
            }
            // Everything is busy or parked. If anything is merely busy, poll briefly; otherwise
            // sleep until the earliest window resets.
            const anyBusy = this.tokens.some(it => it.busy)
            const idleParked = this.tokens.filter(it => !it.busy).map(it => it.parkedUntil)
            const earliestReset = idleParked.length > 0 ? Math.min(...idleParked) : now + 50
            const wait = anyBusy ? 50 : Math.max(50, earliestReset - now)
            await this.sleep(wait)
        }
    }

    release(token: string): void {
        const entry = this.find(token)
        if (entry) entry.busy = false
    }

    /**
     * Records what a response said about the token's budget. `x-ratelimit-remaining` at or below
     * the safety margin parks the token until `x-ratelimit-reset` (a UNIX second).
     */
    observe(token: string, headers: {[name: string]: string | undefined}): void {
        const entry = this.find(token)
        if (!entry) return
        const remaining = Number(headers['x-ratelimit-remaining'])
        const reset = Number(headers['x-ratelimit-reset'])
        if (Number.isFinite(remaining)) entry.remaining = remaining
        if (Number.isFinite(remaining) && remaining <= this.safetyMargin) {
            this.park(entry, Number.isFinite(reset) ? reset * 1000 : this.now() + 60_000)
        }
    }

    /** Parks a token out of band — a 403/429 that carried no usable remaining/reset header. */
    parkFor(token: string, milliseconds: number): void {
        const entry = this.find(token)
        if (entry) this.park(entry, this.now() + milliseconds)
    }

    usage(): TokenUsage[] {
        return this.tokens.map(it => ({
            token: maskToken(it.token), requests: it.requests, remaining: it.remaining, parked: it.parked,
        }))
    }

    private park(entry: PooledToken, until: number): void {
        if (until <= entry.parkedUntil) return
        entry.parkedUntil = until
        entry.parked++
    }

    private find(token: string): PooledToken | undefined {
        return this.tokens.find(it => it.token === token)
    }
}
