/**
 * How many scans run at once, and how many requests may wait for one.
 *
 * A scan is two processes that each keep a core busy for seconds, so the slots are few
 * (`VULN_MAX_SCANS`) and the waiting line is short (`VULN_MAX_QUEUED`). A request that finds the
 * line full is told so at once — a 503 with `Retry-After` — rather than parked behind work it
 * cannot see the end of; depinder retries it, and falls back to scanning locally if it must.
 */

/** Every slot taken and the waiting line full. */
export class BusyError extends Error {
    constructor() {
        super('busy')
    }
}

export type Release = () => void

export interface ScanLimiter {
    /**
     * Resolves with a `release` once a slot is free: at once if one is, else in arrival order.
     * Throws `BusyError` at once when the line is full. A waiter whose `signal` aborts leaves the
     * line and rejects with the signal's reason; it never gets a slot.
     */
    acquire(signal?: AbortSignal): Promise<Release>
    stats(): {running: number, queued: number}
}

export function createScanLimiter(slots: number, maxQueued: number): ScanLimiter {
    let running = 0
    const waiting: {grant: () => void}[] = []

    const release = (): Release => {
        let released = false
        return () => {
            if (released) return
            released = true
            // The slot passes straight to the next waiter, so `running` never dips and a newcomer
            // cannot slip in ahead of the line.
            const next = waiting.shift()
            if (next) next.grant()
            else running--
        }
    }

    return {
        acquire(signal) {
            if (signal?.aborted) return Promise.reject(signal.reason)
            if (running < slots) {
                running++
                return Promise.resolve(release())
            }
            if (waiting.length >= maxQueued) return Promise.reject(new BusyError())
            return new Promise<Release>((resolve, reject) => {
                const onAbort = (): void => {
                    const at = waiting.indexOf(waiter)
                    if (at >= 0) waiting.splice(at, 1)
                    reject(signal!.reason)
                }
                const waiter = {
                    grant: () => {
                        signal?.removeEventListener('abort', onAbort)
                        resolve(release())
                    },
                }
                waiting.push(waiter)
                signal?.addEventListener('abort', onAbort, {once: true})
            })
        },
        stats() {
            return {running, queued: waiting.length}
        },
    }
}
