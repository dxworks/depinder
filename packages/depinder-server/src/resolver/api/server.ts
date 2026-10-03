import Fastify, {type FastifyInstance} from 'fastify'
import type {Config} from '../config.js'
import type {Db} from '../db/db.js'
import type {ResolverEvents} from '../events.js'
import {errorMessage, type Logger} from '@depinder/core'
import type {NotifyBridge} from '../db/notify.js'
import {PRIORITY} from '../db/queue.js'
import type {QueueGroupRow} from '../db/rows.js'
import {BODY_LIMIT_BYTES, clientGone, registerAuth, registerCompress, registerErrorHandler} from '../../shared/http-server.js'
import {handleResolve} from './resolve/handle.js'
import {parseResolveRequest} from './resolve/request.js'
import type {ResolveOutcome, ResolveSink} from './resolve/types.js'
import {createResolveStore, type ResolveStore} from './store.js'
import {chooseEncoding, createNdjsonWriter, type NdjsonWriter} from './stream.js'
import {createVersionCache} from './version-cache.js'

/** `/health` is the only unauthenticated route: container health checks have no token. */
const PUBLIC_PATHS = new Set(['/health'])

interface ApiDeps {
    db: Db
    config: Config
    log: Logger
    /** The worker in this process, if there is one. See `src/resolver/events.ts`. */
    events?: ResolverEvents
    /** The `LISTEN` connection that carries other processes' events. Reported by `GET /queue`. */
    bridge?: NotifyBridge
    /** Overridden in tests. */
    store?: ResolveStore
}

export async function createServer(deps: ApiDeps): Promise<FastifyInstance> {
    const app = Fastify({bodyLimit: BODY_LIMIT_BYTES, logger: false})
    const store = deps.store ?? createResolveStore(deps.db, deps.events)
    // One cache per server, so a test server and the real one never share one.
    const cache = createVersionCache(deps.config.payloadCacheMaxPackages)

    // Every route but `/resolve`, which streams and so compresses for itself (`stream.ts`, with
    // the same two settings): the plugin cannot flush, and would hold the whole stream back. What
    // is left here is small JSON, `/feeds` and the error bodies. See `registerCompress`.
    await registerCompress(app)
    registerAuth(app, deps.config.apiToken, deps.log, PUBLIC_PATHS)
    registerErrorHandler(app, deps.log)

    app.get('/health', async (_request, reply) => {
        try {
            const ok = await deps.db.ping()
            if (ok) return {status: 'ok', db: 'ok'}
        } catch (e) {
            return reply.code(503).send({status: 'degraded', db: 'error', error: errorMessage(e)})
        }
        return reply.code(503).send({status: 'degraded', db: 'error'})
    })

    // Not through the compress plugin: it cannot flush, so it would hold every line of the stream
    // inside the compressor until the end. The route compresses for itself, in `stream.ts`.
    app.post('/resolve', {compress: false}, async (request, reply) => {
        const parsed = parseResolveRequest(request.body)
        const signal = clientGone(reply)
        let writer: NdjsonWriter | undefined

        const sink: ResolveSink = {
            // Only now, with the first read and the queue writes behind us, is a 200 a promise the
            // stream can keep. From here on Fastify is out of the reply: no serialiser, no `onSend`
            // hook, no error handler — the status line has gone and only the bytes are left.
            open() {
                reply.hijack()
                const encoding = chooseEncoding(request.headers['accept-encoding'])
                const headers: Record<string, string> = {
                    'content-type': 'application/x-ndjson',
                    vary: 'accept-encoding',
                }
                if (encoding !== 'identity') headers['content-encoding'] = encoding
                reply.raw.writeHead(200, headers)
                // Sent now rather than with the first line, which may be a whole deadline away:
                // the caller learns at once that the request was taken.
                reply.raw.flushHeaders()
                writer = createNdjsonWriter(reply.raw, encoding)
            },
            async emit(lines) {
                await writer!.write(lines)
                await writer!.flush()
            },
        }

        let outcome: ResolveOutcome
        try {
            outcome = await handleResolve(
                parsed,
                {store, cache, events: deps.events, log: deps.log, signal},
                sink,
            )
        } catch (e) {
            // Before the 200 this is an ordinary failed request, and the error handler answers it.
            if (!writer) throw e
            // After it, the status cannot change. The stream is ended without its trailer, which is
            // how the caller tells a cut-short answer from a whole one: it keeps every line it got,
            // each of them final, and asks again for the purls that got none.
            deps.log.error('resolve stream failed', {
                path: request.url,
                error: errorMessage(e),
                code: (e as {code?: unknown}).code,
            })
            await writer.end()
            return
        }

        if (!writer) {
            // The caller hung up before anything was sent. There is no socket left to write to, so
            // hijacking is how Fastify is told the reply is dealt with — and nothing is logged as an
            // error: a client that walked away is not a server error.
            reply.hijack()
            return
        }
        if (outcome === 'abandoned') writer.destroy()
        else await writer.end()
    })

    app.get('/feeds', async () => {
        const rows = await store.getFeeds()
        const feeds: Record<string, unknown> = {}
        for (const row of rows) {
            feeds[row.type] = {
                mode: row.mode,
                lag_seconds: row.lag_seconds,
                cursor: row.cursor,
                cursor_time: iso(row.cursor_time),
                last_run_at: iso(row.last_run_at),
                last_ok_at: iso(row.last_ok_at),
                upstream_head_time: iso(row.upstream_head_time),
                last_error: row.last_error,
            }
        }
        return {feeds}
    })

    /**
     * The fetch queue at a glance: per ecosystem, how much somebody waits for, how much is waiting,
     * held, retrying, and how old
     * the oldest waiting ask is; how many packages gave up; and whether this process hears other
     * processes. Behind the token, unlike `/health`, which stays a `select 1` for the container
     * health check.
     */
    app.get('/queue', async () => {
        const {groups, errors} = await store.getQueue()
        const types: Record<string, QueueCounts & {by_priority: Record<string, number>}> = {}
        const total = emptyCounts()
        for (const group of groups) {
            const entry = (types[group.type] ??= {...emptyCounts(), by_priority: {}})
            addCounts(entry, group)
            addCounts(total, group)
            const name = PRIORITY_NAMES.get(group.priority) ?? String(group.priority)
            entry.by_priority[name] = (entry.by_priority[name] ?? 0) + group.queued
        }
        return {listener: deps.bridge?.status ?? 'off', errors, total, types}
    })

    return app
}

/**
 * `PRIORITY`, the other way round: `30` reads as `refresh` in `GET /queue`. Names that share a
 * number share a key — `demand` and `feed` are both 20, so it reads `demand/feed`.
 */
const PRIORITY_NAMES = new Map<number, string>()
for (const [name, value] of Object.entries(PRIORITY)) {
    const known = PRIORITY_NAMES.get(value)
    PRIORITY_NAMES.set(value, known ? `${known}/${name}` : name)
}

type QueueCounts = Pick<QueueGroupRow, 'queued' | 'urgent' | 'in_flight' | 'due' | 'retrying' | 'oldest_due_s'>

function emptyCounts(): QueueCounts {
    return {queued: 0, urgent: 0, in_flight: 0, due: 0, retrying: 0, oldest_due_s: 0}
}

function addCounts(into: QueueCounts, group: QueueGroupRow): void {
    into.queued += group.queued
    into.urgent += group.urgent
    into.in_flight += group.in_flight
    into.due += group.due
    into.retrying += group.retrying
    into.oldest_due_s = Math.max(into.oldest_due_s, group.oldest_due_s)
}

function iso(date: Date | null): string | null {
    return date ? date.toISOString() : null
}
