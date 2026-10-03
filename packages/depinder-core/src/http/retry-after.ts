/** How long a 429 (too many requests) asks to be waited out: its `Retry-After`, within bounds. */

/** Used when a 429 carries no usable `Retry-After`. */
export const DEFAULT_RETRY_AFTER_MS = 5_000
/** A longer ask is cut to this: the one retry should still land within a run. */
export const MAX_RETRY_AFTER_MS = 60_000

/** `Retry-After` is either delay-seconds or an HTTP date (RFC 9110, 10.2.3). */
export function retryAfterMs(header: string | null, now: number = Date.now()): number {
    const value = header?.trim()
    if (!value) return DEFAULT_RETRY_AFTER_MS
    const wait = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now
    if (!Number.isFinite(wait)) return DEFAULT_RETRY_AFTER_MS
    return Math.min(Math.max(wait, 0), MAX_RETRY_AFTER_MS)
}
