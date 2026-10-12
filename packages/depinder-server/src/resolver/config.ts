import {bool, ConfigError, int, requireLogLevel, requirePort, requireToken, str} from '../shared/config.js'
import type {LogLevel} from '@depinder/core'

export interface Config {
    /** Postgres connection string. Supabase: direct or session pooler (5432), not the 6543 pooler. */
    databaseUrl: string
    /** `false` disables TLS entirely (local Postgres). */
    databaseSsl: boolean
    /** Postgres connections this process keeps at most. Sized against `fetchConcurrency`. */
    databasePoolSize: number
    /** Of those, how many are the api's alone; the worker gets the rest. */
    apiPoolSize: number
    /** Bearer token required on every route except /health. */
    apiToken: string
    port: number
    logLevel: LogLevel
    /** How many package fetches the demand-fill worker keeps in flight at once. */
    fetchConcurrency: number
    /** Packages whose version tuples the api keeps in memory. 0 disables the cache. */
    payloadCacheMaxPackages: number
    /** Days of `fetch_log` the worker keeps; older rows are deleted by its periodic sweep. */
    fetchLogRetentionDays: number
}

/**
 * Reads config from an environment. Throws `ConfigError` with a message meant for a human
 * reading container logs. The entry points call it through `loadConfigOrExit` (`shared/config.ts`).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    // The vulnerability server is a different process with a different config — no Postgres at
    // all — and `main.ts` hands it to `loadVulnConfig` before this is ever called. Refused by
    // name, and first, so that a mistake there fails loudly instead of asking for a DATABASE_URL.
    if (str(env.ROLE) === 'vuln') throw new ConfigError('ROLE=vuln is loaded by loadVulnConfig')

    const databaseUrl = str(env.DATABASE_URL)
    if (!databaseUrl) {
        throw new ConfigError('DATABASE_URL is required (Postgres connection string; see .env.example).')
    }

    const apiToken = requireToken(env)

    const role = str(env.ROLE) ?? 'resolver'
    if (role !== 'resolver') throw new ConfigError(`ROLE must be resolver or vuln (got "${role}").`)

    const logLevel = requireLogLevel(env)
    const port = requirePort(env)

    // 64 sits just above the ~49 concurrent requests the per-ecosystem limiters in `registries/http.ts` add
    // up to, so the limiters stay the real constraint and the pool is never what idles a registry
    // slot. The headroom covers packages parked in a limiter queue or waiting for a pg client.
    const fetchConcurrency = int(env, 'FETCH_CONCURRENCY', 64, 1, 512)

    // The other half of the fill: the pool above fetches, these connections write. A package spends
    // about as long on its write — five statements, each a round trip to a hosted database — as it
    // does on its registry request, so about half of FETCH_CONCURRENCY is what it takes for no fetch
    // slot ever to stand still waiting for a client. That would be 32, and it is not the default:
    // a Supabase session pooler serves its configured `pool_size` and refuses everything past it
    // outright (EMAXCONNSESSION) rather than queueing, and a stock project's is 15 — for the whole
    // process, api pool and migration lock included. 15 is therefore the most that needs no
    // dashboard change; raise Pool Size there (or connect directly) and then set this to 32.
    const databasePoolSize = int(env, 'DATABASE_POOL_SIZE', 15, 1, 200)

    // The api's own pool, so `/resolve` never queues behind the worker's writes. Carved out of
    // DATABASE_POOL_SIZE because the pooler's ceiling counts the whole process. Eight gives each
    // chunk of a typical depinder run a client of its own: see `docs/configuration.md`.
    const apiPoolSize = int(env, 'API_POOL_SIZE', 8, 1, 200)
    if (apiPoolSize >= databasePoolSize) {
        throw new ConfigError(
            `API_POOL_SIZE (${apiPoolSize}) is carved out of DATABASE_POOL_SIZE (${databasePoolSize}), ` +
            'so it must leave at least one connection for the worker.',
        )
    }

    // Packages, not versions or bytes: a count is the one bound that can be checked without
    // walking anything. 50 000 packages is roughly a whole benchmark run's working set held in
    // maybe 200 MB of tuples — big enough that a six-chunk run never evicts, small enough to be a
    // ceiling. The cache is only ever consulted against the `fetched_at` of a row read this
    // request, so 0 (off) changes nothing but the number of queries.
    const payloadCacheMaxPackages = int(env, 'PAYLOAD_CACHE_MAX_PACKAGES', 50_000, 0)

    // The log is provenance for debugging, read by time window.
    const fetchLogRetentionDays = int(env, 'FETCH_LOG_RETENTION_DAYS', 3, 1, 365)

    return {
        databaseUrl,
        databaseSsl: bool(env.DATABASE_SSL, true),
        databasePoolSize,
        apiPoolSize,
        apiToken,
        port,
        logLevel,
        fetchConcurrency,
        payloadCacheMaxPackages,
        fetchLogRetentionDays,
    }
}

/**
 * How `DATABASE_POOL_SIZE` is split between the two halves of the process: the api gets
 * `API_POOL_SIZE` of its own and the worker the rest, so that the worker's writes can never be what
 * a `/resolve` waits behind. The two pools are separate queues under one connection ceiling.
 *
 * `loadConfig` already refuses an `API_POOL_SIZE` that would leave the worker nothing; the clamp
 * here is so the function is total for a hand-built `Config` in a test.
 */
export function poolSizes(
    config: Pick<Config, 'databasePoolSize' | 'apiPoolSize'>,
): {api: number; worker: number} {
    const api = Math.max(1, Math.min(config.apiPoolSize, config.databasePoolSize - 1))
    return {api, worker: Math.max(1, config.databasePoolSize - api)}
}
