import {describe, expect, it} from 'vitest'
import {loadConfig, poolSizes} from '../../src/resolver/config.js'
import {ConfigError} from '../../src/shared/config.js'

const base = {
    DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/postgres',
    RESOLVER_API_TOKEN: 'test-token-'.padEnd(16, 'x'),
}

describe('loadConfig', () => {
    it('fills in the defaults', () => {
        expect(loadConfig(base)).toEqual({
            databaseUrl: base.DATABASE_URL,
            databaseSsl: true,
            databaseListen: true,
            databasePoolSize: 15,
            apiPoolSize: 8,
            apiToken: base.RESOLVER_API_TOKEN,
            role: 'resolver',
            port: 8080,
            logLevel: 'info',
            fetchConcurrency: 64,
            payloadCacheMaxPackages: 50_000,
        })
    })

    it('refuses to start without a database', () => {
        expect(() => loadConfig({RESOLVER_API_TOKEN: base.RESOLVER_API_TOKEN})).toThrow(/DATABASE_URL is required/)
    })

    it('refuses to start without a token', () => {
        expect(() => loadConfig({DATABASE_URL: base.DATABASE_URL})).toThrow(ConfigError)
        expect(() => loadConfig({DATABASE_URL: base.DATABASE_URL, RESOLVER_API_TOKEN: '   '})).toThrow(
            /RESOLVER_API_TOKEN is required/,
        )
    })

    it('refuses a token that is too short to be worth having', () => {
        expect(() => loadConfig({...base, RESOLVER_API_TOKEN: 'short'})).toThrow(/at least 16 characters/)
        expect(() => loadConfig({...base, RESOLVER_API_TOKEN: 'x'.repeat(15)})).toThrow(/at least 16/)
        expect(loadConfig({...base, RESOLVER_API_TOKEN: 'x'.repeat(16)}).apiToken).toHaveLength(16)
    })

    it('reads the optional settings', () => {
        const config = loadConfig({
            ...base,
            DATABASE_SSL: 'false',
            DATABASE_LISTEN: 'false',
            ROLE: 'resolver-worker',
            PORT: '9000',
            LOG_LEVEL: 'debug',
            FETCH_CONCURRENCY: '16',
            DATABASE_POOL_SIZE: '8',
            API_POOL_SIZE: '2',
            PAYLOAD_CACHE_MAX_PACKAGES: '0',
        })
        expect(config).toMatchObject({
            databaseSsl: false,
            databaseListen: false,
            role: 'resolver-worker',
            port: 9000,
            logLevel: 'debug',
            fetchConcurrency: 16,
            databasePoolSize: 8,
            apiPoolSize: 2,
            // 0 switches the payload cache off; it is a bound, not a toggle, so it has no `false`.
            payloadCacheMaxPackages: 0,
        })
    })

    it('still boots on the old role names, remembering them for a warning', () => {
        expect(loadConfig({...base, ROLE: 'all'})).toMatchObject({role: 'resolver', legacyRole: 'all'})
        expect(loadConfig({...base, ROLE: 'api'})).toMatchObject({role: 'resolver-api', legacyRole: 'api'})
        expect(loadConfig({...base, ROLE: 'worker'})).toMatchObject({role: 'resolver-worker', legacyRole: 'worker'})
        expect(loadConfig({...base, ROLE: 'resolver'}).legacyRole).toBeUndefined()
        expect(loadConfig(base).role).toBe('resolver')
    })

    it('rejects nonsense in the enumerated settings', () => {
        expect(() => loadConfig({...base, ROLE: 'boss'})).toThrow(/ROLE/)
        expect(() => loadConfig({...base, LOG_LEVEL: 'loud'})).toThrow(/LOG_LEVEL/)
        expect(() => loadConfig({...base, PORT: 'eighty'})).toThrow(/PORT/)
        expect(() => loadConfig({...base, PORT: '0'})).toThrow(/PORT/)
        expect(() => loadConfig({...base, FETCH_CONCURRENCY: 'lots'})).toThrow(/FETCH_CONCURRENCY/)
        expect(() => loadConfig({...base, FETCH_CONCURRENCY: '0'})).toThrow(/FETCH_CONCURRENCY/)
        expect(() => loadConfig({...base, FETCH_CONCURRENCY: '513'})).toThrow(/between 1 and 512/)
        expect(() => loadConfig({...base, DATABASE_POOL_SIZE: 'plenty'})).toThrow(/DATABASE_POOL_SIZE/)
        expect(() => loadConfig({...base, DATABASE_POOL_SIZE: '0'})).toThrow(/DATABASE_POOL_SIZE/)
        expect(() => loadConfig({...base, DATABASE_POOL_SIZE: '201'})).toThrow(/between 1 and 200/)
        expect(() => loadConfig({...base, API_POOL_SIZE: 'three'})).toThrow(/API_POOL_SIZE/)
        expect(() => loadConfig({...base, API_POOL_SIZE: '0'})).toThrow(/API_POOL_SIZE/)
        expect(() => loadConfig({...base, PAYLOAD_CACHE_MAX_PACKAGES: 'loads'})).toThrow(/PAYLOAD_CACHE_MAX_PACKAGES/)
        expect(() => loadConfig({...base, PAYLOAD_CACHE_MAX_PACKAGES: '-1'})).toThrow(/>= 0/)
    })

    it('refuses an api pool that would leave the worker nothing', () => {
        expect(() => loadConfig({...base, DATABASE_POOL_SIZE: '3', API_POOL_SIZE: '3'})).toThrow(
            /must leave at least one connection for the worker/,
        )
        expect(() => loadConfig({...base, DATABASE_POOL_SIZE: '3', API_POOL_SIZE: '2'})).not.toThrow()
        // A single role has nothing to share with, so the check does not apply.
        expect(() =>
            loadConfig({...base, ROLE: 'resolver-api', DATABASE_POOL_SIZE: '3', API_POOL_SIZE: '9'}),
        ).not.toThrow()
    })
})

describe('poolSizes', () => {
    const config = {role: 'resolver', databasePoolSize: 15, apiPoolSize: 4} as const

    it('gives a single role the whole allowance', () => {
        expect(poolSizes({...config, role: 'resolver-api'})).toEqual({api: 15, worker: 0})
        expect(poolSizes({...config, role: 'resolver-worker'})).toEqual({api: 0, worker: 15})
    })

    it('carves the api out of the allowance rather than adding to it', () => {
        // The pooler counts the process, not the pool, so the two must still add up to 15.
        expect(poolSizes(config)).toEqual({api: 4, worker: 11})
        expect(poolSizes({...config, apiPoolSize: 5})).toEqual({api: 5, worker: 10})
    })

    it('always leaves both halves a connection, whatever it is handed', () => {
        expect(poolSizes({...config, databasePoolSize: 4, apiPoolSize: 9})).toEqual({api: 3, worker: 1})
        expect(poolSizes({...config, databasePoolSize: 1, apiPoolSize: 1})).toEqual({api: 1, worker: 1})
    })
})
