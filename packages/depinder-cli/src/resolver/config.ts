import {log} from '../utils/logging'

/**
 * Where the bulk purl resolver lives, and how long a run is willing to wait for it.
 *
 * On by default, at `DEFAULT_RESOLVER_URL`, but never required: without a token, or with
 * `--no-resolver`, every dependency goes through the registry fallback. The URL comes from
 * `--resolver-url`, then `DEPINDER_RESOLVER_URL`, then the default.
 */

export interface ResolverConfig {
    /** Base URL of the resolver, without a trailing slash. `/resolve` is appended by the client. */
    url: string
    /** Bearer token. The server refuses every route without it, so an unset token disables the client. */
    token: string
    /**
     * Upper bound on the whole bulk phase. Each post sends what is left of it as `deadline_ms`
     * (capped at the server's 60 s), and the server answers whatever is still open when that passes.
     */
    maxWaitMs: number
    /** How many chunks of one ask are posted at the same time; `Infinity`, the default, is all of them. */
    chunkConcurrency: number
    /**
     * The run's freshness cutoff (epoch milliseconds): a package the server has not confirmed since
     * then comes back `refreshing`. Sent as `max_age`, worked out per post (`maxAgeFor` in
     * `client.ts`). Absent means the server's own default, a day.
     */
    freshAfterMs?: number
}

/** The resolver options `analyse` declares. */
export interface ResolverOptions {
    /** `--resolver-url <url>`. Overrides `DEPINDER_RESOLVER_URL` and `DEFAULT_RESOLVER_URL`. */
    resolverUrl?: string
    /** Commander sets this to `false` for `--no-resolver`, and leaves it `true` otherwise. */
    resolver?: boolean
}

/** The public resolver, used when neither `--resolver-url` nor `DEPINDER_RESOLVER_URL` names one. */
export const DEFAULT_RESOLVER_URL = 'https://libs.dxworks.org'

export const DEFAULT_RESOLVER_MAX_WAIT_MS = 60_000

/**
 * How many chunks of one bulk ask are in flight at once: by default, all of them.
 *
 * The chunks are independent questions, and they share one deadline. Posting them a few at a time
 * made every chunk after the first window wait for a slot — behind the slowest package of the
 * chunk before it — and then go out with whatever was left of that deadline, often nothing: its
 * cold packages were never urgent on the server, and came back `pending` for the registries to
 * fetch one by one. Posted together, every chunk gets the whole budget.
 *
 * The old reason for three no longer holds. It was the server's api pool (`API_POOL_SIZE`, four):
 * a chunk's answer used to be one aggregate held on a connection for the length of its wait, and
 * the fourth connection was kept for the retry a failed chunk was allowed. The answer is a stream
 * now, and a stream holds a client for one query at a time, never for the length of its deadline;
 * and the client no longer retries. `DEPINDER_RESOLVER_CONCURRENCY` still caps it, for a server
 * that turns out to need it.
 */
export const RESOLVER_CHUNK_CONCURRENCY = Infinity

/** The flag, then the environment, then the default; a blank value counts as unset. */
function resolverUrl(options: ResolverOptions): string {
    const configured = [options.resolverUrl, process.env.DEPINDER_RESOLVER_URL]
        .map(value => value?.trim())
        .find(value => value)
    return (configured ?? DEFAULT_RESOLVER_URL).replace(/\/+$/, '')
}

function maxWaitFromEnv(): number {
    const raw = process.env.DEPINDER_RESOLVER_MAX_WAIT_MS
    if (!raw) return DEFAULT_RESOLVER_MAX_WAIT_MS
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        log.warn(`Ignoring DEPINDER_RESOLVER_MAX_WAIT_MS=${raw}: not a positive number of milliseconds`)
        return DEFAULT_RESOLVER_MAX_WAIT_MS
    }
    return parsed
}

function chunkConcurrencyFromEnv(): number {
    const raw = process.env.DEPINDER_RESOLVER_CONCURRENCY
    if (!raw) return RESOLVER_CHUNK_CONCURRENCY
    const parsed = Number(raw)
    if (!Number.isInteger(parsed) || parsed <= 0) {
        log.warn(`Ignoring DEPINDER_RESOLVER_CONCURRENCY=${raw}: not a positive whole number of chunks`)
        return RESOLVER_CHUNK_CONCURRENCY
    }
    return parsed
}

/**
 * The resolver to use for this run, or `undefined` for "no resolver, registry fallback only".
 *
 * Disabled — without failing the run — when `--no-resolver` is given, or when
 * `DEPINDER_RESOLVER_TOKEN` is not set. The second case warns once and says how to fix it.
 */
export function resolverConfig(options: ResolverOptions = {}): ResolverConfig | undefined {
    if (options.resolver === false) return undefined

    const url = resolverUrl(options)
    const token = (process.env.DEPINDER_RESOLVER_TOKEN ?? '').trim()
    if (!token) {
        log.warn(`Resolver at ${url} skipped: set DEPINDER_RESOLVER_TOKEN to use it, or pass --no-resolver`)
        return undefined
    }

    return {
        url,
        token,
        maxWaitMs: maxWaitFromEnv(),
        chunkConcurrency: chunkConcurrencyFromEnv(),
    }
}
