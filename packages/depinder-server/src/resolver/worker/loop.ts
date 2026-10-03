import {errorMessage, type Logger} from '../../shared/log.js'

/**
 * A cancellable "run this every N ms" loop. Ticks never overlap: the next one is scheduled after
 * the current one finishes, so a slow batch slows the loop down instead of piling up behind it.
 * A throwing tick is logged and the loop carries on — a registry being down is not a reason for
 * the worker to stop.
 */
export interface Loop {
    stop(): Promise<void>
    /**
     * Cuts short an idle wait, for a loop that has one — the demand-fill pump naps when the queue
     * is drained, and whoever just queued something can say so. `startLoop` runs on a timer with
     * nothing to interrupt, so it does not implement this.
     */
    wake?(): void
}

interface LoopOptions {
    name: string
    intervalMs: number
    log: Logger
    run: () => Promise<void>
    /**
     * How long to wait before the first run. Default 0 — run as soon as the loop starts. Pass
     * `intervalMs` to wait a full interval, or a small delay to keep boot quick without leaving
     * the loop idle for a whole interval.
     */
    initialDelayMs?: number
}

export function startLoop(options: LoopOptions): Loop {
    let stopped = false
    let timer: NodeJS.Timeout | undefined
    let running: Promise<void> = Promise.resolve()

    const tick = async (): Promise<void> => {
        if (stopped) return
        running = options.run().catch(e => {
            options.log.error(`${options.name} tick failed`, {error: errorMessage(e)})
        })
        await running
        if (!stopped) timer = setTimeout(() => void tick(), options.intervalMs)
    }

    timer = setTimeout(() => void tick(), options.initialDelayMs ?? 0)

    return {
        async stop(): Promise<void> {
            stopped = true
            if (timer) clearTimeout(timer)
            await running.catch(() => undefined)
        },
    }
}

/** Splits a list into fixed-size chunks; used to keep parameterised INSERTs under the pg limit. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
    return out
}
