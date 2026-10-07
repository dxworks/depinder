import {afterEach, describe, expect, it} from 'vitest'
import {MAX_DEADLINE_MS} from '../../../src/resolver/api/resolve/types.js'
import {API_CONNECT_TIMEOUT_MS, createDb, DEFAULT_CONNECT_TIMEOUT_MS, type Db} from '../../../src/resolver/db/db.js'

/**
 * The pool's options, read back off a pool that never connects (pg opens nothing until a query).
 * What a starved pool does with them is pg's business; that the api's bound is long enough is ours.
 */

const config = {databaseUrl: 'postgresql://user:pass@127.0.0.1:1/none', databaseSsl: false, databasePoolSize: 15}

describe('createDb', () => {
    const made: Db[] = []
    const make = (poolSize?: number, connectTimeoutMs?: number): Db => {
        const db = createDb(config, poolSize, connectTimeoutMs)
        made.push(db)
        return db
    }
    afterEach(async () => {
        await Promise.all(made.splice(0).map(d => d.close()))
    })

    it('keeps the ten-second connect timeout and the whole allowance by default', () => {
        const {options} = make().pool
        expect(options.max).toBe(15)
        expect(options.connectionTimeoutMillis).toBe(DEFAULT_CONNECT_TIMEOUT_MS)
        expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(10_000)
    })

    it('takes the pool size and connect timeout it is given', () => {
        const {options} = make(8, API_CONNECT_TIMEOUT_MS).pool
        expect(options.max).toBe(8)
        expect(options.connectionTimeoutMillis).toBe(API_CONNECT_TIMEOUT_MS)
    })

    it("lets the api's queries wait for a client as long as the longest /resolve deadline", () => {
        // Shorter, and a read that queues behind six cold chunks kills a stream that already sent
        // its 200: no trailer, and depinder gives the resolver up for the rest of the run.
        expect(API_CONNECT_TIMEOUT_MS).toBeGreaterThanOrEqual(MAX_DEADLINE_MS)
    })
})
