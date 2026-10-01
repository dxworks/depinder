import {log} from '../utils/logging'

/**
 * Where the bulk purl resolver lives, and how long a run is willing to wait for it.
 *
 * The resolver is opt-in and never required: with no URL configured, `analyse` behaves exactly as
 * it did before — every dependency goes through its plugin's registrar chain. Same shape as
 * `--profile` (`utils/profile.ts`): a flag, an environment variable behind it, and nothing else.
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
    /** How many chunks of one ask are posted at the same time. */
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
    /** `--resolver-url <url>`. Overrides `DEPINDER_RESOLVER_URL`. */
    resolverUrl?: string
    /** Commander sets this to `false` for `--no-resolver`, and leaves it `true` otherwise. */
    resolver?: boolean
}

export const DEFAULT_RESOLVER_MAX_WAIT_MS = 60_000

/**
 * How many chunks of one bulk ask are in flight at once.
 *
 * A run is six chunks of 2000 purls, and the server answers each of them independently — the time
 * is upstream fetches and a large response body, not contention on anything the client owns. Six
 * chunks one after another measured 22-30 s against the same server that answered all six at once
 * in 12-14 s. Not "all of them", because the constraint is at the other end and it is narrow: every
 * chunk's answer is built by one `json_agg` over a single link to a remote database, and the api
 * has four connections to run them on (`API_POOL_SIZE`). Three leaves the fourth for the retry a
 * failed chunk is allowed, which is the one request that must not queue — a retry that waits out
 * the server's connection timeout comes back a 500, and a single 500 is what makes a run give up on
 * the resolver and send every remaining purl to the registries.
 */
export const RESOLVER_CHUNK_CONCURRENCY = 3

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
 * The resolver to use for this run, or `undefined` for "no resolver, registrars only".
 *
 * Disabled — without failing the run — when `--no-resolver` is given, when no URL is configured,
 * or when a URL is configured but `DEPINDER_RESOLVER_TOKEN` is not. The last case warns: it is a
 * misconfiguration rather than a choice, and it would otherwise look like a very slow resolver.
 */
export function resolverConfig(options: ResolverOptions = {}): ResolverConfig | undefined {
    if (options.resolver === false) return undefined

    const url = (options.resolverUrl ?? process.env.DEPINDER_RESOLVER_URL ?? '').trim()
    if (!url) return undefined

    const token = (process.env.DEPINDER_RESOLVER_TOKEN ?? '').trim()
    if (!token) {
        log.warn(`Resolver at ${url} disabled: DEPINDER_RESOLVER_TOKEN is not set`)
        return undefined
    }

    return {
        url: url.replace(/\/+$/, ''),
        token,
        maxWaitMs: maxWaitFromEnv(),
        chunkConcurrency: chunkConcurrencyFromEnv(),
    }
}
