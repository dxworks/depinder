import {beforeAll, describe, expect, it, vi} from 'vitest'
import {createResolveStore} from '../../../../src/resolver/api/store.js'
import type {Config} from '../../../../src/resolver/config.js'
import type {Db} from '../../../../src/resolver/db/db.js'
import {nullLogger} from '../../../../src/shared/log.js'
import {PRIORITY} from '../../../../src/resolver/db/queue.js'
import {npmRegistry} from '../../../../src/resolver/registries/npm.js'
import type {Registry} from '../../../../src/resolver/registries/types.js'
import type {FetchQueueRow, PackageRow} from '../../../../src/resolver/db/rows.js'
import {ensureFeedRows, runFeedOnce} from '../../../../src/resolver/worker/feeds.js'
import {changes, json, type Postgres} from '../db.integration.helpers.js'

/** The npm change feed and the conditional-GET poll, against the real tables. */
export function feedTests(postgres: () => Postgres): void {
    describe('feeds', () => {
        let db: Db
        let config: Config

        beforeAll(() => {
            db = postgres().db
            config = postgres().config
        })

        it('starts the npm feed at the head and then queues what changed', async () => {
            await ensureFeedRows(db)
            // One row per implemented registry, so pick npm's by type rather than by position.
            const [feed] = await db.query<{type: string; mode: string}>(
                "select * from registry_feed where type = 'npm'",
            )
            expect(feed).toMatchObject({type: 'npm', mode: 'feed'})

            vi.stubGlobal('fetch', () => Promise.resolve(json({results: [], last_seq: 31000000})))
            await runFeedOnce(npmRegistry, {db, log: nullLogger, config})
            const [started] = await db.query<{cursor: string; covered_since: Date | null}>(
                "select cursor, covered_since from registry_feed where type = 'npm'",
            )
            expect(started!.cursor).toBe('31000000')
            // Coverage starts with the cursor: only packages fetched from here on are covered by it.
            expect(started!.covered_since).toBeInstanceOf(Date)

            vi.stubGlobal('fetch', () => Promise.resolve(json(changes)))
            await runFeedOnce(npmRegistry, {db, log: nullLogger, config})

            const after = await db.query<{cursor: string; cursor_time: Date; last_error: string | null}>(
                "select cursor, cursor_time, last_error from registry_feed where type = 'npm'",
            )
            expect(after[0]!.cursor).toBe('31000004')
            expect(after[0]!.cursor_time).toBeInstanceOf(Date)
            expect(after[0]!.last_error).toBeNull()
            const [still] = await db.query<{covered_since: Date}>(
                "select covered_since from registry_feed where type = 'npm'",
            )
            expect(still!.covered_since).toEqual(started!.covered_since)

            // Only tracked packages are queued: express is stored, left-pad is not.
            const queue = await db.query<FetchQueueRow>('select * from fetch_queue order by package_key')
            expect(queue.map(q => q.package_key)).toEqual(['pkg:npm/@babel/core', 'pkg:npm/express'])
            expect(queue[0]!.priority).toBe(PRIORITY.feed)

            const feeds = await createResolveStore(db).getFeeds()
            expect(feeds.find(f => f.type === 'npm')!.lag_seconds).toBeGreaterThanOrEqual(0)
        })

        it('polls a conditional-GET ecosystem: queues what changed, vouches for what did not', async () => {
            // The loop around `check`, run with a stand-in registry so each answer is chosen here. The
            // real maven and cargo answers are covered in their own tests and in `shared.test.ts`.
            await db.query('delete from fetch_queue')
            const fetchedAt = new Date('2026-09-01T00:00:00Z')
            await db.query(
                `insert into package (package_key, type, namespace, name, status, poll_etag, fetched_at, as_of)
                 values ('pkg:maven/com.google.guava/guava', 'maven', 'com.google.guava', 'guava', 'resolved', '"old"', $1, $1),
                        ('pkg:maven/org.slf4j/slf4j-api', 'maven', 'org.slf4j', 'slf4j-api', 'resolved', '"same"', $1, $1),
                        ('pkg:maven/junit/junit', 'maven', 'junit', 'junit', 'error', '"unfetched"', null, null)`,
                [fetchedAt],
            )
            await db.query(
                `insert into registry_feed (type, mode) values ('maven', 'poll') on conflict (type) do nothing`,
            )

            const seen: {packageKey: string; etag: string | null; fetchedAt: Date | null}[] = []
            const pollRegistry: Registry = {
                type: 'maven',
                fetchPackage: async () => null,
                feed: {
                    mode: 'poll',
                    intervalMs: 1000,
                    async check(target) {
                        seen.push({packageKey: target.packageKey, etag: target.etag, fetchedAt: target.fetchedAt})
                        if (target.etag === '"old"') return {changed: true, confirmed: false, etag: null, lastModified: null}
                        // A registry that vouched for the never-fetched row too: the loop must not believe it.
                        return {changed: false, confirmed: true}
                    },
                },
            }

            const before = new Date()
            await runFeedOnce(pollRegistry, {db, log: nullLogger, config})

            expect(seen.map(s => s.packageKey).sort()).toEqual([
                'pkg:maven/com.google.guava/guava',
                'pkg:maven/junit/junit',
                'pkg:maven/org.slf4j/slf4j-api',
            ])
            expect(seen.find(s => s.packageKey === 'pkg:maven/org.slf4j/slf4j-api')!.fetchedAt).toEqual(fetchedAt)
            const queue = await db.query<FetchQueueRow>('select * from fetch_queue')
            expect(queue.map(q => q.package_key)).toEqual(['pkg:maven/com.google.guava/guava'])

            const row = async (key: string): Promise<PackageRow> =>
                (await db.query<PackageRow>('select * from package where package_key = $1', [key]))[0]!

            // Changed: requeued, validators cleared, and nothing vouched for until it is refetched.
            const changed = await row('pkg:maven/com.google.guava/guava')
            expect(changed.poll_etag).toBeNull()
            expect(changed.poll_last_modified).toBeNull()
            expect(changed.as_of).toEqual(fetchedAt)

            // Confirmed: as_of moves up to the check, fetched_at stays with the last full fetch.
            const same = await row('pkg:maven/org.slf4j/slf4j-api')
            expect(same.poll_etag).toBe('"same"')
            expect(same.fetched_at).toEqual(fetchedAt)
            expect(same.as_of!.getTime()).toBeGreaterThanOrEqual(before.getTime())

            // Never fully fetched: nothing to vouch for, so a 304 cannot move it.
            const unfetched = await row('pkg:maven/junit/junit')
            expect(unfetched.fetched_at).toBeNull()
            expect(unfetched.as_of).toBeNull()

            const [feed] = await db.query<{last_ok_at: Date | null}>(
                "select last_ok_at from registry_feed where type = 'maven'",
            )
            expect(feed!.last_ok_at).toBeInstanceOf(Date)

            await db.query("delete from package where type = 'maven'")
            await db.query('delete from fetch_queue')
        })

        it('records a feed failure without losing the cursor', async () => {
            vi.stubGlobal('fetch', () => Promise.resolve(json({error: 'nope'}, 503)))
            await runFeedOnce(npmRegistry, {db, log: nullLogger, config})

            const [row] = await db.query<{cursor: string; last_error: string}>(
                "select cursor, last_error from registry_feed where type = 'npm'",
            )
            expect(row!.cursor).toBe('31000004')
            expect(row!.last_error).toMatch(/503/)
        })
    })
}
