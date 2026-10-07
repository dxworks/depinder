import {expect} from 'vitest'
import type {ResolveStore} from '../../../src/resolver/api/store.js'
import {loadConfig} from '../../../src/resolver/config.js'
import type {Db} from '../../../src/resolver/db/db.js'
import type {PackageVersionsRow, QueueStats, RegistryFeedRow, ResolvePackageRow} from '../../../src/resolver/db/rows.js'

/** What the server tests share: a config and token, a store that knows nothing, a fake db. */

export const TOKEN = 'test-token-'.padEnd(20, 'x')

export const config = loadConfig({
    DATABASE_URL: 'postgresql://localhost/x',
    RESOLVER_API_TOKEN: TOKEN,
})

export const feedRow: RegistryFeedRow = {
    type: 'npm',
    mode: 'feed',
    cursor: '31000004',
    cursor_time: new Date('2026-09-16T09:59:00Z'),
    last_run_at: new Date('2026-09-16T09:59:30Z'),
    last_ok_at: new Date('2026-09-16T09:59:30Z'),
    upstream_head_time: null,
    last_error: null,
    covered_since: new Date('2026-09-16T08:00:00Z'),
    lag_seconds: 30,
}

/** A package the store knows, resolved and confirmed a moment ago. */
export function knownRow(key: string): ResolvePackageRow {
    return {
        package_key: key,
        type: 'npm',
        namespace: null,
        name: key.split('/').pop()!,
        description: null,
        homepage_url: null,
        repo_url: null,
        licenses: ['MIT'],
        latest_version: '1.0.0',
        latest_prerelease_version: null,
        status: 'resolved',
        error: null,
        source: 'registry.npmjs.org',
        fetched_at: new Date('2026-09-16T10:00:00Z'),
        as_of: new Date('2026-09-16T10:00:00Z'),
        tracked: true,
        poll_etag: null,
        poll_last_modified: null,
        next_retry_at: null,
        confirmed_at: new Date(),
        queued: false,
    }
}

export const store: ResolveStore = {
    async getPackages(keys: readonly string[]): Promise<ResolvePackageRow[]> {
        void keys
        return []
    },
    async getVersions(): Promise<PackageVersionsRow[]> {
        return []
    },
    async createPending(): Promise<void> {
        return undefined
    },
    async queueRefresh(): Promise<void> {
        return undefined
    },
    async markWanted(): Promise<void> {
        return undefined
    },
    async getFeeds(): Promise<RegistryFeedRow[]> {
        return [feedRow]
    },
    async getQueue(): Promise<QueueStats> {
        return {
            groups: [
                {type: 'cargo', priority: 20, queued: 30, urgent: 10, in_flight: 2, due: 28, retrying: 0, oldest_due_s: 95},
                {type: 'npm', priority: 20, queued: 3, urgent: 3, in_flight: 3, due: 0, retrying: 0, oldest_due_s: 0},
                {type: 'npm', priority: 50, queued: 2, urgent: 0, in_flight: 0, due: 1, retrying: 2, oldest_due_s: 700},
            ],
            errors: 4,
        }
    },
}

// /health is the only route that touches the database directly.
export const db = {ping: async () => true} as unknown as Db

export const auth = {authorization: `Bearer ${TOKEN}`}

/** The lines of an NDJSON body, parsed. */
export function ndjson(text: string): Record<string, unknown>[] {
    expect(text.endsWith('\n')).toBe(true)
    return text.split('\n').slice(0, -1).map(line => JSON.parse(line) as Record<string, unknown>)
}
