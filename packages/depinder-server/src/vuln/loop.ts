import {errorMessage, type Logger} from '@depinder/core'

/**
 * The schedule every update loop shares: the databases' (`updater.ts`) and the scanner binaries'
 * (`scanner-updater.ts`). One pass now, then one every interval; after a failure the next try comes
 * sooner — 5 min, then 10, 20, … up to the interval. At most one pass runs at a time, and `stop`
 * aborts the one in flight.
 *
 * A pass that returns is a success, whether or not it changed anything; one that throws is a
 * failure, logged and kept as `last_error`. A pass cut short by `stop` is neither.
 */

export interface Clock {
    now(): number
    setTimeout(fn: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
}

const systemClock: Clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => {
        const timer = setTimeout(fn, ms)
        // The loop alone does not keep the process alive; the server does.
        timer.unref()
        return timer
    },
    clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout),
}

/** The first retry after a failure; doubled each time, up to the interval. */
export const FIRST_RETRY_MS = 5 * 60_000

export interface LoopStatus {
    /** A pass is running, or waiting for the tool's lock. */
    updating: boolean
    last_ok_at: string | null
    last_error: string | null
    next_check_at: string | null
}

export interface Loop {
    /** Runs the first pass now and keeps going until `stop`. */
    start(): void
    /** Stops the loop and aborts a pass in flight; resolves once it is wound down. */
    stop(): Promise<void>
    /** One pass; while one runs, the same pass. */
    runOnce(): Promise<void>
    status(): LoopStatus
}

/**
 * One tool's work, one piece at a time: its database update and its scanner update both take the
 * tool's lock, so a binary is never switched halfway through a database download, and a database is
 * never swapped under the binary check that is reading it.
 */
export interface Mutex {
    run<T>(fn: () => Promise<T>): Promise<T>
}

export function createMutex(): Mutex {
    let tail: Promise<unknown> = Promise.resolve()
    return {
        run(fn) {
            const result = tail.then(fn)
            tail = result.catch(() => undefined)
            return result
        },
    }
}

export function createLoop(options: {
    /** For the log: `database update`, `scanner update`. */
    name: string
    /** Added to every log line: `{tool}`. */
    fields: Record<string, unknown>
    intervalMs: number
    clock?: Clock
    log: Logger
    lock?: Mutex
    attempt(signal: AbortSignal): Promise<void>
}): Loop {
    const {name, fields, intervalMs, log, lock} = options
    const clock = options.clock ?? systemClock
    const iso = (ms: number): string => new Date(ms).toISOString()

    let running: Promise<void> | undefined
    let controller: AbortController | undefined
    let timer: unknown
    let stopped = false
    let failures = 0
    const status: LoopStatus = {updating: false, last_ok_at: null, last_error: null, next_check_at: null}

    const attempt = (signal: AbortSignal): Promise<void> => {
        // Stopped while it waited for the lock: nothing to start.
        const guarded = (): Promise<void> => signal.aborted ? Promise.reject(new Error('aborted')) : options.attempt(signal)
        return lock ? lock.run(guarded) : guarded()
    }

    const nextDelay = (): number => failures === 0
        ? intervalMs
        : Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), intervalMs)

    const pass = async (): Promise<void> => {
        controller = new AbortController()
        status.updating = true
        try {
            await attempt(controller.signal)
            failures = 0
            status.last_error = null
            status.last_ok_at = iso(clock.now())
        } catch (e) {
            if (stopped) {
                log.info(`${name} stopped`, fields)
            } else {
                failures++
                status.last_error = errorMessage(e)
                log.error(`${name} failed`, {...fields, error: status.last_error, retry_in_ms: nextDelay()})
            }
        } finally {
            status.updating = false
            controller = undefined
        }
    }

    const schedule = (ms: number): void => {
        if (stopped) return
        status.next_check_at = iso(clock.now() + ms)
        timer = clock.setTimeout(() => {
            timer = undefined
            void runOnce().then(() => schedule(nextDelay()))
        }, ms)
    }

    const runOnce = (): Promise<void> => {
        running ??= pass().finally(() => {
            running = undefined
        })
        return running
    }

    return {
        start() {
            stopped = false
            schedule(0)
        },
        async stop() {
            stopped = true
            if (timer !== undefined) clock.clearTimeout(timer)
            timer = undefined
            status.next_check_at = null
            controller?.abort()
            await running
        },
        runOnce,
        status: () => ({...status}),
    }
}
