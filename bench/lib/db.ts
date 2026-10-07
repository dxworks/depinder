import pg from 'pg'
import type {EnvFile} from './env.js'

/**
 * The bench's own view of the resolver's Postgres: counts, the wipe, and the two questions the
 * empty cell asks — what did the server fetch in a window, and has its queue drained yet.
 *
 * Plain SQL against the schema in migrations/, not the service's code: the bench must keep working
 * while src/ is reorganised.
 */

export type BenchDb = pg.Pool

/** A small pool: the bench runs one query at a time, and the pooler's slots belong to the server. */
export function openDb(env: EnvFile): BenchDb {
    const ssl = (env.DATABASE_SSL ?? 'true').toLowerCase() !== 'false'
    const pool = new pg.Pool({
        connectionString: env.DATABASE_URL,
        ssl: ssl ? {rejectUnauthorized: false} : false,
        max: 2,
        connectionTimeoutMillis: 15_000,
        // No query may hang the bench: the slowest is the truncate, which waits for locks. Client
        // side only: the session pooler need not accept a statement_timeout startup parameter.
        query_timeout: 120_000,
    })
    // An idle client dropped by the pooler must not crash the bench; the next query reconnects.
    pool.on('error', () => {})
    return pool
}

export interface Counts {
    packages: number
    pending: number
    versions: number
    queued: number
    fetchLog: number
}

export async function counts(db: BenchDb): Promise<Counts> {
    const {rows: [row]} = await db.query(`select
        (select count(*) from package)                           as packages,
        (select count(*) from package where status = 'pending')  as pending,
        (select count(*) from package_version)                   as versions,
        (select count(*) from fetch_queue)                       as queued,
        (select count(*) from fetch_log)                         as fetch_log`)
    return {
        packages: Number(row.packages),
        pending: Number(row.pending),
        versions: Number(row.versions),
        queued: Number(row.queued),
        fetchLog: Number(row.fetch_log),
    }
}

export function formatCounts(c: Counts): string {
    return `packages=${c.packages} pending=${c.pending} versions=${c.versions} queued=${c.queued} fetch_log=${c.fetchLog}`
}

/**
 * Empties every service table. The schema and the migration ledger survive, so the resolver boots
 * straight into an empty DB. Run only with the resolver stopped: a worker writing during the
 * truncate would leave rows behind (the count check after it would say so).
 */
export async function truncateAll(db: BenchDb): Promise<void> {
    await db.query('truncate table package_version, package, fetch_queue, fetch_log, registry_feed restart identity cascade')
}

export interface Window {
    start: Date
    end: Date
}

export interface FetchedInWindow {
    /** Packages settled as resolved or not_found with `fetched_at` in the window, per purl type. */
    byType: Record<string, number>
    total: number
    /** fetch_log rows (HTTP requests the worker made) started in the window. */
    requests: number
    /** Of those, the ones made for a package (the rest are feed polls, which have no package). */
    packageRequests: number
}

export async function fetchedIn(db: BenchDb, w: Window): Promise<FetchedInWindow> {
    const {rows} = await db.query(
        `select type, count(*)::int as n from package
          where status in ('resolved', 'not_found') and fetched_at between $1 and $2
          group by type order by type`,
        [w.start, w.end],
    )
    const {rows: [log]} = await db.query(
        `select count(*)::int as requests, count(package_key)::int as package_requests
           from fetch_log where started_at between $1 and $2`,
        [w.start, w.end],
    )
    const byType = Object.fromEntries(rows.map(r => [r.type as string, r.n as number]))
    return {
        byType,
        total: Object.values(byType).reduce((a, b) => a + b, 0),
        requests: log.requests,
        packageRequests: log.package_requests,
    }
}

/** Package rows per status, for the empty cell's "what the server holds now". */
export async function byStatus(db: BenchDb): Promise<Record<string, number>> {
    const {rows} = await db.query('select status, count(*)::int as n from package group by status order by status')
    return Object.fromEntries(rows.map(r => [r.status as string, r.n as number]))
}

/**
 * Drained: nothing pending and nothing queued. Feeds can queue news for a tracked package at any
 * time, so this is a moment, not a steady state — the first poll that sees it counts.
 */
export async function isDrained(db: BenchDb): Promise<{drained: boolean, pending: number, queued: number}> {
    const c = await counts(db)
    return {drained: c.pending === 0 && c.queued === 0, pending: c.pending, queued: c.queued}
}
