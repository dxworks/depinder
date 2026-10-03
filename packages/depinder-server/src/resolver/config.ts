import {bool, ConfigError, requireLogLevel, requirePort, requireToken, str} from '../shared/config.js'
import type {LogLevel} from '@depinder/core'

export type Role = 'api' | 'worker' | 'all'

export interface Config {
    /** Postgres connection string. Supabase: direct or session pooler (5432), not the 6543 pooler. */
    databaseUrl: string
    /** `false` disables TLS entirely (local Postgres). */
    databaseSsl: boolean
    /**
     * Keep one more connection, outside the pool, that `LISTEN`s for queue and settle notifications
     * from other processes. See `src/resolver/db/notify.ts`. Off means polling only.
     */
    databaseListen: boolean
    /** Postgres connections this process keeps at most. Sized against `fetchConcurrency`. */
    databasePoolSize: number
    /** Of those, how many are the api's alone when this process also runs the worker. */
    apiPoolSize: number
    /** Bearer token required on every route except /health. */
    apiToken: string
    role: Role
    port: number
    logLevel: LogLevel
    /** How many package fetches the demand-fill worker keeps in flight at once. */
    fetchConcurrency: number
    /** Packages whose version tuples the api keeps in memory. 0 disables the cache. */
    payloadCacheMaxPackages: number
}

const ROLES: Role[] = ['api', 'worker', 'all']

/**
 * Reads config from an environment. Throws `ConfigError` with a message meant for a human
 * reading container logs. `loadConfigOrExit` is what the entry points use.
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

    const role = (str(env.ROLE) ?? 'all') as Role
    if (!ROLES.includes(role)) {
        throw new ConfigError(`ROLE must be one of ${ROLES.join(', ')} (got "${role}").`)
    }

    const logLevel = requireLogLevel(env)
    const port = requirePort(env)

    // 64 sits just above the ~49 concurrent requests the per-ecosystem limiters in `registries/http.ts` add
    // up to, so the limiters stay the real constraint and the pool is never what idles a registry
    // slot. The headroom covers packages parked in a limiter queue or waiting for a pg client.
    const concurrencyRaw = str(env.FETCH_CONCURRENCY) ?? '64'
    const fetchConcurrency = Number(concurrencyRaw)
    if (!Number.isInteger(fetchConcurrency) || fetchConcurrency < 1 || fetchConcurrency > 512) {
        throw new ConfigError(`FETCH_CONCURRENCY must be an integer between 1 and 512 (got "${concurrencyRaw}").`)
    }

    // The other half of the fill: the pool above fetches, these connections write. A package spends
    // about as long on its write — five statements, each a round trip to a hosted database — as it
    // does on its registry request, so about half of FETCH_CONCURRENCY is what it takes for no fetch
    // slot ever to stand still waiting for a client. That would be 32, and it is not the default:
    // a Supabase session pooler serves its configured `pool_size` and refuses everything past it
    // outright (EMAXCONNSESSION) rather than queueing, and a stock project's is 15 — for the whole
    // process, api role and migration lock included. 15 is therefore the most that needs no
    // dashboard change; raise Pool Size there (or connect directly) and then set this to 32.
    const poolSizeRaw = str(env.DATABASE_POOL_SIZE) ?? '15'
    const databasePoolSize = Number(poolSizeRaw)
    if (!Number.isInteger(databasePoolSize) || databasePoolSize < 1 || databasePoolSize > 200) {
        throw new ConfigError(`DATABASE_POOL_SIZE must be an integer between 1 and 200 (got "${poolSizeRaw}").`)
    }

    // The api's share of the pool above, and the reason `/resolve` can no longer be starved by the
    // worker. One pool for both halves meant 64 fetch slots queueing for the same 15 clients with a
    // request's `getPackages` somewhere in that queue, and pg does not queue a waiter forever: after
    // `connectionTimeoutMillis` it rejects with "timeout exceeded when trying to connect", which is
    // an HTTP 500 for a caller who did nothing wrong.
    //
    // Eight, because of how depinder asks. It posts every chunk of a run at once
    // (RESOLVER_CHUNK_CONCURRENCY is unbounded), up to 2 000 purls a chunk, so a 10 000-purl run is
    // six requests in flight together, and it never retries one: a chunk whose stream dies is
    // answered from the registries instead, package by package. On a cold version cache each chunk
    // reads its versions in 500-package queries of 2-8 s against a hosted database, holding a
    // client for one query at a time but asking for one again straight away. Six chunks on four
    // clients queued past the old ten-second connect timeout, one stream ended without its
    // trailer, and a 15 s run took 152 s. Eight gives each of those six chunks a client of its own
    // and leaves two for /feeds, /health and a seventh chunk; the connect timeout is no longer ten
    // seconds either (see `API_CONNECT_TIMEOUT_MS` in `db/db.ts`). It is carved OUT of
    // DATABASE_POOL_SIZE rather than added to it, because the ceiling that matters is the pooler's
    // and it counts the whole process: with the Pro pooler's 45 and DATABASE_POOL_SIZE=32 that is 8
    // for the api, 24 for the worker and one LISTEN connection, 33 in all.
    const apiPoolRaw = str(env.API_POOL_SIZE) ?? '8'
    const apiPoolSize = Number(apiPoolRaw)
    if (!Number.isInteger(apiPoolSize) || apiPoolSize < 1 || apiPoolSize > 200) {
        throw new ConfigError(`API_POOL_SIZE must be an integer between 1 and 200 (got "${apiPoolRaw}").`)
    }
    if (role === 'all' && apiPoolSize >= databasePoolSize) {
        throw new ConfigError(
            `API_POOL_SIZE (${apiPoolSize}) is carved out of DATABASE_POOL_SIZE (${databasePoolSize}) when ROLE=all, ` +
            'so it must leave at least one connection for the worker.',
        )
    }

    // Packages, not versions or bytes: a count is the one bound that can be checked without
    // walking anything. 50 000 packages is roughly a whole benchmark run's working set held in
    // maybe 200 MB of tuples — big enough that a six-chunk run never evicts, small enough to be a
    // ceiling. The cache is only ever consulted against the `fetched_at` of a row read this
    // request, so 0 (off) changes nothing but the number of queries.
    const cacheRaw = str(env.PAYLOAD_CACHE_MAX_PACKAGES) ?? '50000'
    const payloadCacheMaxPackages = Number(cacheRaw)
    if (!Number.isInteger(payloadCacheMaxPackages) || payloadCacheMaxPackages < 0) {
        throw new ConfigError(`PAYLOAD_CACHE_MAX_PACKAGES must be an integer >= 0 (got "${cacheRaw}").`)
    }

    return {
        databaseUrl,
        databaseSsl: bool(env.DATABASE_SSL, true),
        databaseListen: bool(env.DATABASE_LISTEN, true),
        databasePoolSize,
        apiPoolSize,
        apiToken,
        role,
        port,
        logLevel,
        fetchConcurrency,
        payloadCacheMaxPackages,
    }
}

/**
 * How `DATABASE_POOL_SIZE` is split between the two halves of the process.
 *
 * A single role has nothing to split: `api` and `worker` each get the whole allowance, which is
 * what a two-container deployment wants. `all` gives the api `API_POOL_SIZE` of its own and the
 * worker the rest, so that the worker's writes can never be what a `/resolve` waits behind — the
 * two pools are separate queues, and one process still opens no more connections than before.
 *
 * `loadConfig` already refuses an `API_POOL_SIZE` that would leave the worker nothing; the clamp
 * here is so the function is total for a hand-built `Config` in a test.
 */
export function poolSizes(
    config: Pick<Config, 'role' | 'databasePoolSize' | 'apiPoolSize'>,
): {api: number; worker: number} {
    if (config.role === 'api') return {api: config.databasePoolSize, worker: 0}
    if (config.role === 'worker') return {api: 0, worker: config.databasePoolSize}
    const api = Math.max(1, Math.min(config.apiPoolSize, config.databasePoolSize - 1))
    return {api, worker: Math.max(1, config.databasePoolSize - api)}
}

/** Entry-point wrapper: a readable message on stderr and exit code 1 instead of a stack trace. */
export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): Config {
    try {
        return loadConfig(env)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        process.stderr.write(`depinder-server-side: configuration error\n  ${msg}\n`)
        process.exit(1)
    }
}
