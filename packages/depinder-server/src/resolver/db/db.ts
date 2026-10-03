import {readdir, readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import pg from 'pg'
import type {PoolClient, QueryResultRow} from 'pg'
import type {Config} from '../config.js'
import {nullLogger, type Logger} from '../../shared/log.js'

const {Pool} = pg

/**
 * Postgres access. Hand-written SQL, no ORM: the queries here are the interesting part of the
 * service (`FOR UPDATE SKIP LOCKED`, array columns, upserts) and an ORM would only hide them.
 */

export interface Queryable {
    query<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<T[]>
}

export interface Db extends Queryable {
    /** First row, or undefined. */
    one<T extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<T | undefined>
    /** Runs `fn` inside BEGIN/COMMIT on one client; rolls back if it throws. */
    withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>
    /** `select 1`, for /health. */
    ping(): Promise<boolean>
    close(): Promise<void>
    readonly pool: pg.Pool
}

/**
 * Postgres' error code for the transaction it chose to abort to break a deadlock. Both statements
 * of `createPending` are idempotent upserts and the whole transaction rolled back, so the only
 * thing to do about one is to run it again.
 */
export const DEADLOCK_DETECTED = '40P01'

/** True when `e` is the transaction Postgres killed to break a deadlock (SQLSTATE 40P01). */
export function isDeadlock(e: unknown): boolean {
    return typeof e === 'object' && e !== null && (e as {code?: unknown}).code === DEADLOCK_DETECTED
}

/**
 * How long a worker query waits for a pool client before pg rejects it with `timeout exceeded when
 * trying to connect`. A worker that waits this long is better off failing the package and retrying
 * it later than holding a fetch slot.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/**
 * The same for the api's pool, and as long as the longest `/resolve` deadline (`MAX_DEADLINE_MS`,
 * 60 s, in `api/resolve/types.ts`; a test holds the two together). A request's reads are the only
 * thing it has to send, so a read that has to queue for a client should make the request slow, not
 * kill it: at ten seconds, six cold chunks on the api's clients queued past the bound, pg threw, and
 * a stream that had already sent its `200` ended without its trailer, which depinder takes as the
 * resolver being gone for the rest of the run. Sixty seconds is a ceiling, not a wait anyone
 * expects; a client is held for one query at a time, so the queue moves every few seconds.
 */
export const API_CONNECT_TIMEOUT_MS = 60_000

/**
 * A pool and the handful of helpers around it.
 *
 * `poolSize` defaults to the whole of `DATABASE_POOL_SIZE` and is passed explicitly when a process
 * runs both roles: the api and the worker then get a pool each out of that one ceiling, because a
 * pool they share is a pool the worker holds every client of. See `poolSizes` in `config.ts`.
 * `connectTimeoutMs` is how long a query may wait for one of those clients; `main.ts` gives the
 * api's pool {@link API_CONNECT_TIMEOUT_MS}.
 */
export function createDb(
    config: Pick<Config, 'databaseUrl' | 'databaseSsl' | 'databasePoolSize'>,
    poolSize: number = config.databasePoolSize,
    connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Db {
    const pool = new Pool({
        connectionString: config.databaseUrl,
        // Supabase serves a shared certificate that is not in Node's trust store, so verification
        // is off while TLS itself stays on. Set DATABASE_SSL=false only for a local Postgres.
        ssl: config.databaseSsl ? {rejectUnauthorized: false} : false,
        // How much of the worker can be writing at once. The database is hosted, so every statement
        // costs a round trip and a package that waits here for a client is a fetch slot standing
        // still: see DATABASE_POOL_SIZE in .env.example for how this is sized against
        // FETCH_CONCURRENCY.
        max: poolSize,
        idleTimeoutMillis: 30_000,
        // Waiting for a client is bounded, and the bound is a rejection: pg drops a waiter that has
        // sat in the pending queue this long with `timeout exceeded when trying to connect`, which
        // reaches a route as a plain Error and so as an HTTP 500, or, once a stream is open, as a
        // stream without its trailer. That is the whole reason the api no longer queues behind the
        // worker for one, and why its own bound is the longest deadline rather than ten seconds.
        connectionTimeoutMillis: connectTimeoutMs,
    })

    // An idle client dropped by the network must not take the process down with it.
    pool.on('error', () => undefined)

    return wrap(pool)
}

function wrap(pool: pg.Pool): Db {
    const query = async <T extends QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<T[]> => {
        const result = await pool.query<T>(text, params as unknown[])
        return result.rows
    }

    return {
        pool,
        query,
        async one<T extends QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<T | undefined> {
            const rows = await query<T>(text, params)
            return rows[0]
        },
        async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
            const client = await pool.connect()
            try {
                await client.query('begin')
                const result = await fn(clientQueryable(client))
                await client.query('commit')
                return result
            } catch (e) {
                await client.query('rollback').catch(() => undefined)
                throw e
            } finally {
                client.release()
            }
        },
        async ping(): Promise<boolean> {
            const rows = await query<{ok: number}>('select 1 as ok')
            return rows.length === 1
        },
        async close(): Promise<void> {
            await pool.end()
        },
    }
}

function clientQueryable(client: PoolClient): Queryable {
    return {
        async query<T extends QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<T[]> {
            const result = await client.query<T>(text, params as unknown[])
            return result.rows
        },
    }
}

// --- migrations ---------------------------------------------------------------------------

/** Any bigint; it only has to be the same in every process running these migrations. */
const MIGRATION_LOCK_ID = 8_271_542_001

/** `migrations/` sits next to `src/` in the repo and next to `dist/` in the image. */
export function migrationsDir(): string {
    return fileURLToPath(new URL('../../../migrations/', import.meta.url))
}

/**
 * Applies every `.sql` file in `migrations/` that is not in `schema_migrations`, in filename
 * order, each in its own transaction. A session-level advisory lock keeps two booting instances
 * from applying the same file twice.
 *
 * @returns the names applied by this call.
 */
export async function migrate(db: Db, log: Logger = nullLogger, dir = migrationsDir()): Promise<string[]> {
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()
    const client = await db.pool.connect()
    const applied: string[] = []
    try {
        await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
        await client.query(`
            create table if not exists schema_migrations (
                name       text primary key,
                applied_at timestamptz not null default now()
            )
        `)
        const done = new Set(
            (await client.query<{name: string}>('select name from schema_migrations')).rows.map(r => r.name),
        )

        for (const file of files) {
            if (done.has(file)) continue
            const sql = await readFile(path.join(dir, file), 'utf8')
            log.info('applying migration', {migration: file})
            try {
                await client.query('begin')
                await client.query(sql)
                await client.query('insert into schema_migrations (name) values ($1)', [file])
                await client.query('commit')
            } catch (e) {
                await client.query('rollback').catch(() => undefined)
                throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`)
            }
            applied.push(file)
        }
    } finally {
        await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined)
        client.release()
    }
    return applied
}
