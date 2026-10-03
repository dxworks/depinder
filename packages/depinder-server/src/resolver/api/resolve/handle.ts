import {isSupportedType, tryParsePurl, type ParsedPurl} from '../../../shared/purl.js'
import type {ResolvePackageRow} from '../../db/rows.js'
import {Abandoned, emit, send, stopIfGone, type Open, type ResolveContext, type Wanted} from './context.js'
import {iso} from './payload.js'
import {
    GATHER_MS,
    POLL_INTERVAL_MS,
    VERSION_SLICE,
    type FeedPayload,
    type ResolveDeps,
    type ResolveItem,
    type ResolveOutcome,
    type ResolveRequest,
    type ResolveSink,
    type ResultStatus,
} from './types.js'
import {waitForOpen} from './wait.js'

/**
 * `POST /resolve`: the one call depinder makes per chunk of purls, answered as a stream.
 *
 * Purls are canonicalised and grouped by package key, so a project that uses forty versions of
 * the same library costs one line in the answer rather than forty. Each package is sent exactly
 * once, when its answer is final for this request: anything already known at once; anything
 * unknown, inserted as `pending` and queued, as soon as the worker lands it; anything known but
 * older than the caller's `max_age`, queued for a refresh and sent when that refetch lands. At the
 * caller's `deadline_ms` whatever is still open goes out with what is known — `refreshing` with the
 * last facts, or `pending` — and a trailer line closes the stream. The caller can start its own
 * per-package work while the server is still fetching the rest.
 *
 * The handler knows nothing about HTTP. It is a producer: it hands batches of lines to a
 * {@link ResolveSink}, and the route turns each batch into bytes and flushes them. That split is
 * also where the status code is decided: everything up to and including the queue writes can
 * still fail as a normal HTTP error, and the sink is opened — the route sends `200` — only once
 * they have succeeded. Past that point a failure can only end the stream without its trailer.
 *
 * A package's versions travel as {@link CompactVersion} tuples, built by the query itself. The
 * package-level fields that still carry dates — `latest` and `latest_prerelease` — are derived back
 * out of those tuples in `payload.ts`.
 *
 * A caller that gives up is stopped being worked for. Everything after `createPending` — the wait,
 * the version reads, the feed read — exists only to be sent, so an aborted request starts no further
 * read and returns `'abandoned'` rather than spending another poll interval and a multi-megabyte
 * `json_agg` on a socket that is already gone. That matters because those are the api's only pool
 * clients (`API_POOL_SIZE`, eight): a burst of chunks posted at once, some of them abandoned
 * client-side but still building payloads here, is how a live chunk ends up queueing for a
 * connection behind reads nobody will receive. `createPending` and `queueRefresh` are deliberately NOT
 * abandoned: they have already committed work the next caller wants done.
 */

/** What the first read decided: what is final already, and what this request queued. */
interface FirstRead {
    ready: [key: string, status: ResultStatus][]
    refresh: string[]
    unknown: ParsedPurl[]
}

// [0] TRAIL A→Z, 15 stops: api/resolve/ → worker/fill/ → registries/types.ts → registries/npm.ts
// [1] IN: {purls: string[], deadline_ms?, max_age?} and nothing else — parseResolveRequest in request.ts is the entire shape check.
/**
 * The steps, in order: group the purls by package ({@link createContext}), read what is known
 * ({@link lookUp}), queue what is missing or stale ({@link queueWork}), then stream the answers
 * as they become final and close with the trailer ({@link serve}).
 */
export async function handleResolve(
    request: ResolveRequest,
    deps: ResolveDeps,
    sink: ResolveSink,
): Promise<ResolveOutcome> {
    const ctx = createContext(request, deps, sink)
    const {ready, refresh, unknown} = await lookUp(ctx)
    await queueWork(ctx, refresh, unknown)

    try {
        await serve(ctx, ready)
    } catch (e) {
        if (!(e instanceof Abandoned)) throw e
        // The one line an abandoned request leaves behind, wherever it was when it found out. A
        // client walking away is not a server error, so it is not logged as one.
        deps.log?.debug('resolve abandoned, caller gone', {
            purls: request.purls.length,
            packages: ctx.keys.length,
            open: ctx.open.size,
            sent: Object.values(ctx.counts).reduce((a, b) => a + b, 0),
            wait_ms: ctx.waitMs,
            versions_ms: ctx.versionsMs,
            total_ms: ctx.now() - ctx.startedAt,
        })
        return 'abandoned'
    }

    // Where a request's time went, split where the incidents were: `wait_ms` is time the stream
    // stayed open for the worker, capped by `deadline_ms`; `versions_ms` is the version reads, capped
    // by nothing, and what concurrent chunks pile onto one remote database link. At debug, one line.
    deps.log?.debug('resolve served', {
        purls: request.purls.length,
        packages: ctx.keys.length,
        ...ctx.counts,
        queued_refresh: refresh.length,
        reads: ctx.reads,
        wait_ms: ctx.waitMs,
        versions_ms: ctx.versionsMs,
        total_ms: ctx.now() - ctx.startedAt,
    })
    return 'done'
}

/** The request's clock and limits, and its purls grouped by package key. Reads nothing. */
function createContext(request: ResolveRequest, deps: ResolveDeps, sink: ResolveSink): ResolveContext {
    const now = deps.now ?? (() => Date.now())
    const startedAt = now()

    // [2] Dedupe: up to 5000 purls → N distinct package keys. One question per package, never one per purl.
    const invalid: ResolveItem[] = []
    const wanted = new Map<string, Wanted>()
    for (const purl of request.purls) {
        const parsed = toParsed(purl)
        if (typeof parsed === 'string') {
            invalid.push({key: null, purls: [purl], status: 'invalid', reason: parsed})
            continue
        }
        const known = wanted.get(parsed.packageKey)
        if (known) known.purls.push(purl)
        else wanted.set(parsed.packageKey, {parsed, purls: [purl]})
    }

    return {
        request,
        deps,
        sink,
        store: deps.store,
        signal: deps.signal,
        now,
        sleep: deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms))),
        pollInterval: deps.pollIntervalMs ?? POLL_INTERVAL_MS,
        gatherMs: deps.gatherMs ?? GATHER_MS,
        slice: deps.versionSlice ?? VERSION_SLICE,
        startedAt,
        deadline: startedAt + request.deadlineMs,
        invalid,
        wanted,
        keys: [...wanted.keys()],
        packages: new Map(),
        first: new Map(),
        open: new Map(),
        counts: {resolved: 0, refreshing: 0, not_found: 0, pending: 0, invalid: 0, error: 0},
        reads: 1,
        versionsMs: 0,
        waitMs: 0,
    }
}

/**
 * The first read, and what it decides for each key: final already, open until its first fetch
 * lands, or open until a refetch does. Leaves `ctx.open` holding the open ones.
 */
async function lookUp(ctx: ResolveContext): Promise<FirstRead> {
    const {keys, packages, open, wanted, deadline} = ctx
    for (const row of await ctx.store.getPackages(keys)) packages.set(row.package_key, row)
    ctx.first = new Map(packages)

    // Known, but not confirmed recently enough for this caller. Decided once, on this first read:
    // a package that lands while we wait was fetched by this request and is as fresh as anything
    // can be, whatever `max_age` says — `max_age: 0` means "refresh what you had", not "refresh
    // what you just fetched".
    const cutoff = ctx.startedAt - ctx.request.maxAgeS * 1000
    const ready: [key: string, status: ResultStatus][] = []
    const refresh: string[] = []
    const unknown: ParsedPurl[] = []
    for (const key of keys) {
        const row = packages.get(key)
        if (!row) {
            unknown.push(wanted.get(key)!.parsed)
            open.set(key, 'unknown')
        } else if (row.status === 'pending') {
            // Another request created it, and its fetch is already on the way.
            open.set(key, 'unknown')
        } else if (row.status !== 'resolved' || !isStale(row, cutoff)) {
            ready.push([key, row.status])
        } else if (row.next_retry_at !== null) {
            // A refetch is already scheduled — a refresh that failed waiting out its retry (the
            // worker's `giveUp`), or a re-check the registry asked for (`FetchedPackage.recheckAt`).
            // That schedule is the backoff, and a request must not pull it forward. One that falls
            // after the deadline cannot land in time, so there is nothing to hold it for.
            if (row.next_retry_at.getTime() > deadline) ready.push([key, 'refreshing'])
            else open.set(key, 'stale')
        } else {
            // Queued, unless a fetch of it is already on its way — then that is the one waited for.
            if (!row.queued) refresh.push(key)
            open.set(key, 'stale')
        }
    }
    return {ready, refresh, unknown}
}

/** The queue writes: refetch the stale, create and fetch the unknown, and want all of it now. */
async function queueWork(ctx: ResolveContext, refresh: string[], unknown: ParsedPurl[]): Promise<void> {
    const {store, request} = ctx
    // Neither is skipped for a caller who has already gone: the queue row outlives the request that
    // asked for it, and dropping it here would only make the next run wait for the same fetch.
    //
    // Everything this request waits for is wanted until its deadline: urgent, ahead of everything
    // nobody waits for, in the queue and in the registry limiters, until then. A deadline of 0
    // waits for nothing and so wants nothing.
    const wantedUntil = request.deadlineMs > 0 ? new Date(ctx.deadline) : null
    if (refresh.length > 0) await store.queueRefresh(refresh, wantedUntil)
    // [3] Unknown package → insert 'pending' and enqueue it. Nothing in this file ever calls a registry.
    if (unknown.length > 0) await store.createPending(unknown, wantedUntil)
    // What another request already queued — a package pending on its fetch, or a stale one already
    // being refreshed — is waited for here too, and perhaps for longer.
    if (wantedUntil) {
        const queuedByOthers = new Set([...refresh, ...unknown.map(p => p.packageKey)])
        const others = [...ctx.open.keys()].filter(key => !queuedByOthers.has(key))
        if (others.length > 0) await store.markWanted(others, wantedUntil)
    }
}

/**
 * The stream: opens the sink, sends what is final, waits for the rest until the deadline, sends
 * what is left as it stands, and closes with the trailer. Throws {@link Abandoned} the moment it
 * finds the caller gone.
 */
async function serve(ctx: ResolveContext, ready: readonly [string, ResultStatus][]): Promise<void> {
    const {now, deadline, open} = ctx
    // The last moment a caller who has gone costs nothing: no 200, no line, no read.
    stopIfGone(ctx)
    await ctx.sink.open()

    // Everything final already: the invalid purls, then what the first read answered.
    await send(ctx, ready, ctx.invalid)

    const waitStartedAt = now()
    // [4] Wait on the worker: it says when it has committed, and our OWN db is the 2s fallback.
    try {
        if (open.size > 0 && now() < deadline) await waitForOpen(ctx)
    } finally {
        ctx.waitMs = now() - waitStartedAt
    }

    // The deadline, or nothing left open. A stale package whose refetch did not land goes out
    // with the facts we have; an unknown one that is still unfetched goes out as `pending`.
    await send(ctx, [...open].map(([key, kind]) => [key, kind === 'stale' ? 'refreshing' : 'pending']))
    open.clear()

    stopIfGone(ctx)
    const feeds: Record<string, FeedPayload> = {}
    for (const feed of await ctx.store.getFeeds()) {
        feeds[feed.type] = {
            mode: feed.mode,
            lag_seconds: feed.lag_seconds ?? null,
            cursor_time: iso(feed.cursor_time),
        }
    }
    // [5] OUT: one line per package, as each became final, then the trailer. Next stop [6], in worker/fill/dequeue.ts.
    await emit(ctx, [{done: true, feeds}])
}

/** Resolved, but not confirmed since `cutoff` — or never confirmed at all. */
function isStale(row: ResolvePackageRow, cutoff: number): boolean {
    return row.confirmed_at === null || row.confirmed_at.getTime() < cutoff
}

/** The parsed purl, or why it cannot be used. */
function toParsed(purl: string): ParsedPurl | string {
    const parsed = tryParsePurl(purl)
    if (!parsed.ok) return parsed.reason || 'not a usable purl'
    if (!isSupportedType(parsed.purl.type)) return `unsupported purl type "${parsed.purl.type}"`
    return parsed.purl
}
