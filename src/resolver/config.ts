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
    /** Upper bound on the whole bulk phase, including re-asks for purls the server is still filling. */
    maxWaitMs: number
}

/** The options `analyse` and `export-blackduck` declare; both commands share this shape. */
export interface ResolverOptions {
    /** `--resolver-url <url>`. Overrides `DEPINDER_RESOLVER_URL`. */
    resolverUrl?: string
    /** Commander sets this to `false` for `--no-resolver`, and leaves it `true` otherwise. */
    resolver?: boolean
}

export const DEFAULT_RESOLVER_MAX_WAIT_MS = 60_000

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

    return {url: url.replace(/\/+$/, ''), token, maxWaitMs: maxWaitFromEnv()}
}
