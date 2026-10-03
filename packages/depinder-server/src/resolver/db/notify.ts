import pg from 'pg'
import type {Config} from '../config.js'
import type {ResolverEvents} from '../events.js'
import {errorMessage, type Logger} from '../../shared/log.js'

/**
 * `ResolverEvents` across processes: the same two signals, carried by Postgres `LISTEN/NOTIFY`.
 *
 * The senders are the statements that commit the change: every write into `fetch_queue` notifies
 * {@link CHANNEL_QUEUED}, every terminal package write notifies {@link CHANNEL_SETTLED} with the
 * package key, and marking a package a worker holds as wanted notifies {@link CHANNEL_WANTED}. Postgres delivers a notification only when its transaction commits, which is
 * exactly the "after the commit, never inside it" rule `events.ts` asks of the in-process calls,
 * and it folds identical notifications within one transaction into one.
 *
 * This end listens on one connection of its own — outside the pool, because a pooled client is
 * handed back between queries and a `LISTEN` lives on its session — and replays what it hears into
 * the process's `ResolverEvents`. The in-process calls stay as they are: under `ROLE=all` they cost
 * nothing and need no connection, and hearing the same thing twice is harmless (`/resolve` ignores
 * a key it is no longer waiting on, and a wake is a wake). Nothing depends on a notification
 * arriving either: while the connection is down, both halves fall back to the database poll, and
 * this reconnects with backoff.
 *
 * Supabase's session pooler (5432) keeps a session per client, so `LISTEN` works through it; the
 * transaction pooler (6543) would not, and `config.ts` already rules it out.
 */

export const CHANNEL_QUEUED = 'fetch_queued'
export const CHANNEL_SETTLED = 'package_settled'
/**
 * A caller now waits for a package a worker already holds: payload `<package key> <epoch ms>`, the
 * caller's deadline. Sent only for rows a worker holds (`leased`), since a row still waiting in
 * the queue is ranked by its `wanted_until` at dequeue and needs no one told.
 */
export const CHANNEL_WANTED = 'package_wanted'

/** Reconnect backoff: doubles from the first to the last, then stays there. */
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export type BridgeStatus = 'connected' | 'reconnecting' | 'off'

export interface NotifyBridge {
    readonly status: BridgeStatus
    stop(): Promise<void>
}

/** The part of `pg.Client` the bridge uses, so a test can hand it a fake. */
export interface ListenClient {
    connect(): Promise<unknown>
    query(text: string): Promise<unknown>
    end(): Promise<void>
    on(event: 'notification', listener: (message: {channel: string; payload?: string}) => void): unknown
    on(event: 'error' | 'end', listener: (error?: Error) => void): unknown
}

interface NotifyBridgeOptions {
    config: Pick<Config, 'databaseUrl' | 'databaseSsl'>
    events: ResolverEvents
    log: Logger
    /** Tests only: where clients come from. Defaults to a `pg.Client` on `DATABASE_URL`. */
    connect?: () => ListenClient
    reconnectMinMs?: number
}

/** A bridge that is not there: what `DATABASE_LISTEN=false` gets. */
export const NO_BRIDGE: NotifyBridge = {status: 'off', stop: async () => undefined}

export function startNotifyBridge(options: NotifyBridgeOptions): NotifyBridge {
    const {config, events} = options
    const log = options.log.child({component: 'notify'})
    const newClient =
        options.connect ??
        ((): ListenClient =>
            new pg.Client({
                connectionString: config.databaseUrl,
                ssl: config.databaseSsl ? {rejectUnauthorized: false} : false,
            }))
    const minMs = options.reconnectMinMs ?? RECONNECT_MIN_MS

    let status: BridgeStatus = 'reconnecting'
    let stopped = false
    let client: ListenClient | undefined
    let retry: NodeJS.Timeout | undefined
    let delay = minMs

    const onNotification = (message: {channel: string; payload?: string}): void => {
        if (message.channel === CHANNEL_QUEUED) events.queued()
        else if (message.channel === CHANNEL_SETTLED && message.payload) events.settled(message.payload)
        else if (message.channel === CHANNEL_WANTED && message.payload) {
            // `<package key> <epoch ms>`. A key never holds a space: purls are percent-encoded.
            const at = message.payload.lastIndexOf(' ')
            const until = Number(message.payload.slice(at + 1))
            if (at > 0 && Number.isFinite(until)) events.wanted(message.payload.slice(0, at), until)
        }
    }

    /** Drops the current client, once, and schedules the next attempt. */
    const lost = (current: ListenClient, why: string): void => {
        if (client !== current) return
        client = undefined
        current.end().catch(() => undefined)
        if (stopped) return
        status = 'reconnecting'
        log.warn('listen connection lost, polling until it is back', {error: why, retryInMs: delay})
        retry = setTimeout(() => void open(), delay)
        retry.unref?.()
        delay = Math.min(delay * 2, RECONNECT_MAX_MS)
    }

    const open = async (): Promise<void> => {
        retry = undefined
        if (stopped) return
        const current = newClient()
        client = current
        current.on('error', e => lost(current, e ? errorMessage(e) : 'error'))
        current.on('end', () => lost(current, 'connection ended'))
        current.on('notification', onNotification)
        try {
            await current.connect()
            await current.query(`listen ${CHANNEL_QUEUED}`)
            await current.query(`listen ${CHANNEL_SETTLED}`)
            await current.query(`listen ${CHANNEL_WANTED}`)
        } catch (e) {
            lost(current, errorMessage(e))
            return
        }
        if (client !== current) return
        status = 'connected'
        delay = minMs
        log.info('listening for queue and settle notifications')
    }

    void open()

    return {
        get status() {
            return status
        },
        async stop() {
            stopped = true
            status = 'off'
            if (retry) clearTimeout(retry)
            const current = client
            client = undefined
            await current?.end().catch(() => undefined)
        },
    }
}
