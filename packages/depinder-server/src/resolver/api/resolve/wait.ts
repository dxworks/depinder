import type {ResolvePackageRow} from '../../db/rows.js'
import {send, stopIfGone, type ResolveContext} from './context.js'
import {time} from './payload.js'
import type {ResultStatus} from './types.js'

/**
 * Sends each open package as it lands, until none is left open or the deadline passes.
 *
 * Two things make it look. A `settled` event for a key it is waiting on starts a
 * {@link GATHER_MS} window, and everything that settles in it is read together — one
 * `getPackages`, then one version read per slice. Only one read runs at a time; a key that
 * settles during one waits for the next. Then, every {@link POLL_INTERVAL_MS}, every key still
 * open is read whatever was heard, which is all a worker in another process gets.
 *
 * A stream holds a pool client for one query at a time, never for the wait between them.
 */
export async function waitForOpen(ctx: ResolveContext): Promise<void> {
    const {deps, signal, open, now, sleep, deadline, pollInterval, gatherMs} = ctx
    // One listener for the request, not one per key — 5 000 purls would otherwise be 5 000
    // subscriptions. The set is what turns a key we were told about into "read this one".
    const settled = new Set<string>()
    let firstSettledAt = 0
    let wake: (() => void) | undefined
    const unsubscribe = deps.events?.onSettled(key => {
        if (!open.has(key) || settled.has(key)) return
        if (settled.size === 0) firstSettledAt = now()
        settled.add(key)
        wake?.()
    })
    // The caller going away has to end the sleep rather than be noticed after it: holding the
    // stream open for another two seconds on behalf of nobody is what this is for.
    let giveUp: (() => void) | undefined
    const onAbort = (): void => giveUp?.()
    signal?.addEventListener('abort', onAbort)

    /** Sleeps `ms`, cut short by the caller leaving — and, if `onSettle`, by a key landing. */
    const nap = async (ms: number, onSettle: boolean): Promise<void> => {
        if (ms <= 0) return
        const races: Promise<unknown>[] = [sleep(ms)]
        if (onSettle && deps.events) races.push(new Promise<void>(resolve => (wake = resolve)))
        if (signal) races.push(new Promise<void>(resolve => (giveUp = resolve)))
        await Promise.race(races)
        wake = undefined
        giveUp = undefined
    }

    let lastPollAt = now()
    try {
        while (open.size > 0) {
            stopIfGone(ctx)
            if (now() >= deadline) return

            let batch: string[]
            if (settled.size === 0) {
                await nap(Math.min(lastPollAt + pollInterval, deadline) - now(), true)
                stopIfGone(ctx)
            }
            if (settled.size > 0) {
                await nap(Math.min(firstSettledAt + gatherMs, deadline) - now(), false)
                stopIfGone(ctx)
                batch = [...settled].filter(key => open.has(key))
            } else if (now() >= lastPollAt + pollInterval && now() < deadline) {
                batch = [...open.keys()]
                lastPollAt = now()
            } else {
                continue
            }
            settled.clear()

            ctx.reads++
            const landed: [string, ResultStatus][] = []
            for (const row of await ctx.store.getPackages(batch)) {
                const key = row.package_key
                ctx.packages.set(key, row)
                const status = landedAs(ctx, key, row)
                if (status) {
                    open.delete(key)
                    landed.push([key, status])
                }
            }
            await send(ctx, landed)
        }
    } finally {
        unsubscribe?.()
        signal?.removeEventListener('abort', onAbort)
    }
}

/**
 * The status an open package goes out with now, or null while it has not landed.
 *
 * An unknown package has landed once it is no longer `pending`. A stale one, once its refetch
 * has committed (`fetched_at` moved on from the first read), or it has stopped being `resolved`
 * — or once the refresh has given up: then `error` is set and a new `next_retry_at` is
 * scheduled, the facts it had are kept, and it goes out `refreshing` with them rather than
 * hold the stream for a retry that is an hour away.
 */
function landedAs(ctx: ResolveContext, key: string, row: ResolvePackageRow): ResultStatus | null {
    if (row.status === 'pending') return null
    if (ctx.open.get(key) === 'unknown' || row.status !== 'resolved') return row.status
    const before = ctx.first.get(key)!
    if (time(row.fetched_at) > time(before.fetched_at)) return 'resolved'
    const failedAgain =
        row.error !== null &&
        row.next_retry_at !== null &&
        (before.error === null || time(row.next_retry_at) !== time(before.next_retry_at))
    return failedAgain ? 'refreshing' : null
}
