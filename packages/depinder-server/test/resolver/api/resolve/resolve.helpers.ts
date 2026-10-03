import {expect} from 'vitest'
import {handleResolve} from '../../../../src/resolver/api/resolve/handle.js'
import {
    DEFAULT_MAX_AGE_S,
    GATHER_MS,
    type ResolveDeps,
    type ResolveItem,
    type ResolveLine,
    type ResolveRequest,
    type ResolveSink,
    type ResolveTrailer,
} from '../../../../src/resolver/api/resolve/types.js'
import type {ResolveStore} from '../../../../src/resolver/api/store.js'
import type {ParsedPurl} from '@depinder/core'
import type {
    CompactVersion,
    PackageVersionsRow,
    QueueStats,
    RegistryFeedRow,
    ResolvePackageRow,
} from '../../../../src/resolver/db/rows.js'

/** What the `handleResolve` tests share: a fake store, a sink that collects, and clocks. */

export function packageRow(overrides: Partial<ResolvePackageRow> & Pick<ResolvePackageRow, 'package_key'>): ResolvePackageRow {
    return {
        type: 'npm',
        namespace: null,
        name: 'express',
        description: null,
        homepage_url: null,
        repo_url: null,
        licenses: [],
        latest_version: null,
        latest_prerelease_version: null,
        status: 'resolved',
        error: null,
        source: 'registry.npmjs.org',
        fetched_at: new Date('2026-09-16T10:00:00Z'),
        as_of: new Date('2026-09-16T09:59:00Z'),
        tracked: true,
        poll_etag: null,
        poll_last_modified: null,
        next_retry_at: null,
        // Confirmed a moment ago, so a package is fresh unless a test says otherwise.
        confirmed_at: new Date(),
        queued: false,
        ...overrides,
    }
}

/**
 * A version as the SQL hands it over: epoch seconds, a flags bitfield, and a licenses element
 * only when the version's own list differs from its package's.
 */
export function version(v: string, released: string | null, flags = 0, licenses?: string[]): CompactVersion {
    const epoch = released === null ? null : Math.floor(new Date(released).getTime() / 1000)
    return licenses ? [v, epoch, flags, licenses] : [v, epoch, flags]
}

export class FakeStore implements ResolveStore {
    packages = new Map<string, ResolvePackageRow>()
    versions = new Map<string, CompactVersion[]>()
    feeds: RegistryFeedRow[] = []
    created: string[][] = []
    /** The keys each queueRefresh was asked for, in order. */
    refreshed: string[][] = []
    /** The deadline each createPending, queueRefresh and markWanted call carried, in call order. */
    deadlines: {call: string; until: Date | null}[] = []
    /** The keys each markWanted was asked for, in order. */
    markedWanted: string[][] = []
    /** The keys each getPackages was asked for, in order. */
    packageKeys: string[][] = []
    /** The keys each getVersions was asked for, in order. */
    versionKeys: string[][] = []
    feedCalls = 0
    /** Called before each getPackages answers, so a test can let the worker "finish" mid-wait. */
    onGetPackages: (() => void) | undefined

    get getPackagesCalls(): number {
        return this.packageKeys.length
    }

    async getPackages(keys: readonly string[]): Promise<ResolvePackageRow[]> {
        this.packageKeys.push([...keys])
        this.onGetPackages?.()
        return keys.map(key => this.packages.get(key)).filter((row): row is ResolvePackageRow => row !== undefined)
    }

    async getVersions(keys: readonly string[]): Promise<PackageVersionsRow[]> {
        this.versionKeys.push([...keys])
        return keys
            .filter(key => this.versions.has(key))
            .map(key => ({package_key: key, versions: this.versions.get(key)!}))
    }

    async createPending(purls: readonly ParsedPurl[], wantedUntil: Date | null): Promise<void> {
        this.created.push(purls.map(p => p.packageKey))
        this.deadlines.push({call: 'createPending', until: wantedUntil})
        for (const purl of purls) {
            this.packages.set(purl.packageKey, packageRow({
                package_key: purl.packageKey,
                type: purl.type,
                namespace: purl.namespace,
                name: purl.name,
                status: 'pending',
                source: null,
                fetched_at: null,
                as_of: null,
                confirmed_at: null,
                queued: true,
            }))
        }
    }

    async queueRefresh(keys: readonly string[], wantedUntil: Date | null): Promise<void> {
        this.refreshed.push([...keys])
        this.deadlines.push({call: 'queueRefresh', until: wantedUntil})
    }

    async markWanted(keys: readonly string[], wantedUntil: Date): Promise<void> {
        this.markedWanted.push([...keys])
        this.deadlines.push({call: 'markWanted', until: wantedUntil})
    }

    async getFeeds(): Promise<RegistryFeedRow[]> {
        this.feedCalls++
        return this.feeds
    }

    async getQueue(): Promise<QueueStats> {
        return {groups: [], errors: 0}
    }
}

/** A sink that keeps every batch it is handed, so a test reads the stream as the route would send it. */
export class Collector implements ResolveSink {
    opened = 0
    batches: ResolveLine[][] = []
    /** Lines handed over before `open` — which must never happen. */
    early = 0

    open(): void {
        this.opened++
    }

    async emit(lines: readonly ResolveLine[]): Promise<void> {
        if (this.opened === 0) this.early += lines.length
        this.batches.push([...lines])
    }

    get lines(): ResolveLine[] {
        return this.batches.flat()
    }

    get items(): ResolveItem[] {
        return this.lines.filter((line): line is ResolveItem => 'status' in line)
    }

    get trailer(): ResolveTrailer | undefined {
        const last = this.lines.at(-1)
        return last && 'done' in last ? last : undefined
    }

    item(key: string | null): ResolveItem | undefined {
        return this.items.find(it => it.key === key)
    }
}

/** A request answered with what is known right now: no wait, unless a test says otherwise. */
export const ask = (purls: string[], extra: Partial<ResolveRequest> = {}): ResolveRequest => ({
    purls,
    deadlineMs: 0,
    maxAgeS: DEFAULT_MAX_AGE_S,
    ...extra,
})

/** A clock that only moves when the handler sleeps, and moves by exactly what it asked for. */
export function fakeClock(start = 0): {now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number} {
    let t = start
    return {now: () => t, sleep: async ms => void (t += ms), elapsed: () => t - start}
}

/**
 * A clock on which only the {@link GATHER_MS} window passes. A poll interval never ends on it, so
 * a test that finishes proves an event, not a poll, is what made the stream look.
 */
export function eventClock(start = 0): {now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number} {
    let t = start
    return {
        now: () => t,
        sleep: ms => (ms <= GATHER_MS ? Promise.resolve(void (t += ms)) : new Promise<void>(() => undefined)),
        elapsed: () => t - start,
    }
}

/** Runs the handler to the end, for the tests that are not about a caller going away. */
export async function resolve(request: ResolveRequest, deps: ResolveDeps): Promise<Collector> {
    const sink = new Collector()
    const outcome = await handleResolve(request, deps, sink)
    if (outcome !== 'done') throw new Error('handleResolve gave up: the caller was gone')
    expect(sink.early).toBe(0)
    expect(sink.opened).toBe(1)
    // The contract's one ordering rule: the trailer, exactly once, last.
    expect(sink.lines.filter(line => 'done' in line)).toHaveLength(1)
    expect(sink.trailer).toBeTruthy()
    return sink
}

export const tick = () => new Promise(resolve => setTimeout(resolve, 0))
