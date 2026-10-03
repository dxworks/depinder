import type {ParsedPurl} from '@depinder/core'
import type {CompactVersion, ResolvePackageRow} from '../../db/rows.js'
import type {ResolveStore} from '../store.js'
import {toPackagePayload} from './payload.js'
import type {ResolveDeps, ResolveItem, ResolveLine, ResolveRequest, ResolveSink, ResultStatus} from './types.js'

/** A package the request asked about: how to create it, and every purl that named it. */
export interface Wanted {
    parsed: ParsedPurl
    purls: string[]
}

/** What a key still open is waiting for: its first fetch, or a refetch of facts we already hold. */
export type Open = 'unknown' | 'stale'

/** Thrown inside the handler the moment the caller is found to have gone; never escapes it. */
export class Abandoned extends Error {}

/**
 * Everything one request carries from step to step of `handleResolve`. The steps share it rather
 * than each other's locals: what was read, what is still open, what has been sent, where the time
 * went. One per request, never shared.
 */
export interface ResolveContext {
    request: ResolveRequest
    deps: ResolveDeps
    sink: ResolveSink
    store: ResolveStore
    signal: AbortSignal | undefined
    now: () => number
    sleep: (ms: number) => Promise<void>
    pollInterval: number
    gatherMs: number
    slice: number
    startedAt: number
    deadline: number
    /** One `invalid` line per purl that cannot be used, sent ahead of everything else. */
    invalid: ResolveItem[]
    wanted: Map<string, Wanted>
    keys: string[]
    /** The latest row read for each key. */
    packages: Map<string, ResolvePackageRow>
    /** The rows as this request first found them: what a stale package's refetch is measured against. */
    first: Map<string, ResolvePackageRow>
    open: Map<string, Open>
    counts: Record<ResultStatus, number>
    reads: number
    versionsMs: number
    waitMs: number
}

export function stopIfGone(ctx: ResolveContext): void {
    if (ctx.signal?.aborted === true) throw new Abandoned()
}

export async function emit(ctx: ResolveContext, lines: ResolveLine[]): Promise<void> {
    if (lines.length === 0) return
    stopIfGone(ctx)
    for (const line of lines) if ('status' in line) ctx.counts[line.status]++
    await ctx.sink.emit(lines)
}

/**
 * The version tuples for `keys`: what this process already holds under the `fetched_at` just
 * read, and one query for the rest. A read already running cannot be unmade when the caller
 * leaves, but the cache keeps what it cost, so whoever asks next gets it free.
 */
async function versionsOf(ctx: ResolveContext, keys: readonly string[]): Promise<Map<string, CompactVersion[]>> {
    const {deps, packages, now} = ctx
    const versions = new Map<string, CompactVersion[]>()
    const uncached: string[] = []
    for (const key of keys) {
        const fetchedAt = packages.get(key)!.fetched_at
        const held = fetchedAt ? deps.cache?.get(key, fetchedAt) : undefined
        if (held) versions.set(key, held)
        else uncached.push(key)
    }
    if (uncached.length === 0) return versions
    stopIfGone(ctx)
    const readStartedAt = now()
    for (const row of await ctx.store.getVersions(uncached)) versions.set(row.package_key, row.versions)
    ctx.versionsMs += now() - readStartedAt
    for (const key of uncached) {
        const fetchedAt = packages.get(key)!.fetched_at
        // A resolved package with no versions at all gets no row back, and is worth remembering
        // as the empty list rather than asked for again every request.
        if (fetchedAt) deps.cache?.set(key, fetchedAt, versions.get(key) ?? [])
    }
    return versions
}

function item(
    ctx: ResolveContext,
    key: string,
    status: ResultStatus,
    versions?: Map<string, CompactVersion[]>,
): ResolveItem {
    const row = ctx.packages.get(key)
    const line: ResolveItem = {key, purls: ctx.wanted.get(key)!.purls, status}
    if (row && (status === 'resolved' || status === 'refreshing')) {
        line.package = toPackagePayload(row, versions?.get(key) ?? [])
    }
    if (status === 'error') line.reason = row?.error ?? 'the registry could not be read'
    return line
}

/**
 * Sends these packages, each with its final status: the ones that carry no versions in one
 * batch, then the rest a {@link VERSION_SLICE} at a time — one version read and one flush each.
 */
export async function send(
    ctx: ResolveContext,
    answers: readonly [string, ResultStatus][],
    before: ResolveItem[] = [],
): Promise<void> {
    const carries = (status: ResultStatus): boolean => status === 'resolved' || status === 'refreshing'
    await emit(ctx, [...before, ...answers.filter(([, s]) => !carries(s)).map(([key, s]) => item(ctx, key, s))])
    const full = answers.filter(([, s]) => carries(s))
    for (let i = 0; i < full.length; i += ctx.slice) {
        const batch = full.slice(i, i + ctx.slice)
        const versions = await versionsOf(ctx, batch.map(([key]) => key))
        await emit(ctx, batch.map(([key, s]) => item(ctx, key, s, versions)))
    }
}
