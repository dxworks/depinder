import {vi} from 'vitest'
import {loadConfig} from '../../../../src/resolver/config.js'
import type {Db, Queryable} from '../../../../src/resolver/db/db.js'
import {setTimeout as sleep} from 'node:timers/promises'
import type {FetchQueueRow} from '../../../../src/resolver/db/rows.js'

/**
 * What the demand-fill tests share. Postgres and the registries are both faked: the queue is an
 * array, and every packument comes from a stubbed `fetch` whose delay the test decides.
 */

export const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/x',
    RESOLVER_API_TOKEN: 'test-token-'.padEnd(16, 'x'),
})

export interface FakeDb {
    db: Db
    /** The `limit` asked for by every dequeue, in order. */
    dequeues: number[]
    /** Packages whose write transaction has finished, in completion order. */
    written: string[]
    /** What is still queued and not leased, in queue order. */
    remaining: string[]
    /** The keys every lease heartbeat renewed, one entry per heartbeat. */
    heartbeats: string[][]
}

/** A `Db` that serves one dequeue-able queue and remembers what was written. */
export function fakeDb(queued: readonly string[], wanted: ReadonlyMap<string, Date> = new Map()): FakeDb {
    const remaining = [...queued]
    const dequeues: number[] = []
    const written: string[] = []
    const heartbeats: string[][] = []

    const query = async (text: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> => {
        if (text.includes('and leased')) {
            heartbeats.push([...(params[0] as string[])])
            return []
        }
        if (text.includes('update fetch_queue q')) {
            const limit = params[0] as number
            dequeues.push(limit)
            return takeDue(remaining, params).map(key => queueRow(key, 0, wanted.get(key) ?? null))
        }
        // The queue delete is the tail of the package write, not a statement of its own.
        if (text.includes('delete from fetch_queue')) {
            written.push(params[0] as string)
        }
        return []
    }

    const db = {
        query,
        one: async (text: string, params?: readonly unknown[]) => (await query(text, params))[0],
        withTransaction: <T>(fn: (tx: Queryable) => Promise<T>) => fn({query} as Queryable),
        ping: async () => true,
        close: async () => undefined,
    } as unknown as Db

    return {db, dequeues, written, remaining, heartbeats}
}

/**
 * What the dequeue statement does to an in-order queue: the first `limit` keys whose type still has
 * quota left, taken out. Its parameters are `[limit, types, quotas]`, as `dequeue` passes them.
 */
export function takeDue(remaining: string[], params: readonly unknown[]): string[] {
    const [limit, types, ns] = params as [number, string[], number[]]
    const left = new Map(types.map((type, i) => [type, ns[i]!]))
    const taken: string[] = []
    for (let i = 0; i < remaining.length && taken.length < limit; ) {
        const type = typeOf(remaining[i]!)
        const n = left.get(type) ?? 0
        if (n > 0) {
            left.set(type, n - 1)
            taken.push(...remaining.splice(i, 1))
        } else {
            i++
        }
    }
    return taken
}

/** `pkg:cargo/serde` -> `cargo`, as the generated `fetch_queue.type` column has it. */
export function typeOf(packageKey: string): string {
    return packageKey.slice('pkg:'.length, packageKey.indexOf('/'))
}

export function queueRow(packageKey: string, attempts = 0, wantedUntil: Date | null = null): Record<string, unknown> {
    const row: FetchQueueRow = {
        package_key: packageKey,
        priority: 10,
        requested_at: new Date(),
        attempts,
        next_attempt_at: new Date(),
        last_error: null,
        requests: 1,
        type: typeOf(packageKey),
        leased: true,
        wanted_until: wantedUntil,
    }
    return row as unknown as Record<string, unknown>
}

/** One statement as the worker issued it. `begin`, `commit` and `rollback` stand for themselves. */
export interface Statement {
    text: string
    params: readonly unknown[]
}

export const BOUNDARIES = ['begin', 'commit', 'rollback']

/**
 * A `Db` that serves one dequeue and keeps every statement, in order and with its parameters —
 * transaction boundaries included, exactly where `withTransaction` in `db.ts` issues them. `fail`
 * picks the statement that throws, which is how a half-written package is provoked.
 */
export function recordingDb(
    queued: readonly string[],
    fail?: (text: string) => boolean,
    attempts = 0,
): {db: Db; statements: Statement[]} {
    const remaining = [...queued]
    const statements: Statement[] = []

    const query = async (text: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> => {
        statements.push({text, params})
        if (fail?.(text)) throw new Error('write failed')
        if (text.includes('update fetch_queue q')) {
            return takeDue(remaining, params).map(key => queueRow(key, attempts))
        }
        return []
    }

    const db = {
        query,
        one: async (text: string, params?: readonly unknown[]) => (await query(text, params))[0],
        async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
            statements.push({text: 'begin', params: []})
            try {
                const result = await fn({query} as Queryable)
                statements.push({text: 'commit', params: []})
                return result
            } catch (e) {
                statements.push({text: 'rollback', params: []})
                throw e
            }
        },
        ping: async () => true,
        close: async () => undefined,
    } as unknown as Db

    return {db, statements}
}

/** The statements that touch `package_version`: the write, or the bare delete when nothing is left. */
export function versionStatements(statements: readonly Statement[]): Statement[] {
    return statements.filter(s => s.text.includes('package_version'))
}

/** The smallest packument the npm registry file accepts, carrying whatever versions it is given. */
export function packument(name: string, versions: readonly string[] = ['1.0.0']): unknown {
    return {
        name,
        'dist-tags': {latest: versions[versions.length - 1]},
        time: Object.fromEntries(versions.map(v => [v, '2026-01-01T00:00:00Z'])),
        versions: Object.fromEntries(versions.map(v => [v, {license: 'MIT'}])),
    }
}

export let active = 0
export let peak = 0

/** Answers every packument request; `hold(name)` decides how long that one takes. */
export function stubFetch(hold: (name: string) => Promise<void>): void {
    vi.stubGlobal('fetch', async (input: string | URL) => {
        const url = String(input)
        const name = url.slice(url.lastIndexOf('/') + 1)
        active++
        peak = Math.max(peak, active)
        try {
            await hold(name)
            return new Response(JSON.stringify(packument(name)), {
                status: 200,
                headers: {'content-type': 'application/json'},
            })
        } finally {
            active--
        }
    })
}

/** Answers every packument request at once: with `versions`, or with a 404 when it is null. */
export function stubPackument(versions: readonly string[] | null): void {
    vi.stubGlobal('fetch', async (input: string | URL) => {
        const url = String(input)
        const name = url.slice(url.lastIndexOf('/') + 1)
        const headers = {'content-type': 'application/json'}
        if (!versions) return new Response('{}', {status: 404, headers})
        return new Response(JSON.stringify(packument(name, versions)), {status: 200, headers})
    })
}

export async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2_000
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await sleep(5)
    }
}

export function packages(count: number): string[] {
    return Array.from({length: count}, (_, i) => `pkg:npm/p${i}`)
}

/** Before each test: nothing in flight, and no peak yet. */
export function resetCounters(): void {
    active = 0
    peak = 0
}
