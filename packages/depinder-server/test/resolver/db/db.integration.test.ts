import {copyFileSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {loadConfig, type Config} from '../../../src/resolver/config.js'
import {createDb, migrate, migrationsDir, type Db} from '../../../src/resolver/db/db.js'
import {pruneFetchLog} from '../../../src/resolver/db/fetch-log.js'
import {nullLogger} from '@depinder/core'
import type {FetchQueueRow, PackageRow} from '../../../src/resolver/db/rows.js'
import {packageWriteTests} from './integration/writes.js'
import {feedTests} from './integration/feeds.js'
import {queueTests} from './integration/queue.js'
import {freshnessTests} from './integration/freshness.js'
import {url, type Postgres} from './db.integration.helpers.js'

/**
 * Exercises the SQL against a real Postgres. Skipped unless TEST_DATABASE_URL points at a
 * throwaway database, so `npm test` needs neither a network nor a server:
 *
 *   docker run -d --rm --name depinder-pg -e POSTGRES_PASSWORD=depinder -e POSTGRES_DB=depinder \
 *     -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder npm test
 *
 * It truncates every table it touches, so do not aim it at anything you care about.
 */

describe.skipIf(!url)('postgres', () => {
    let db: Db
    let config: Config

    beforeAll(async () => {
        config = loadConfig({DATABASE_URL: url!, RESOLVER_API_TOKEN: 'x'.repeat(16), DATABASE_SSL: 'false'})
        db = createDb(config)
        await migrate(db, nullLogger)
        await db.query('truncate package, package_version, fetch_queue, fetch_log, registry_feed')
    })

    afterAll(async () => {
        await db?.close()
    })

    afterEach(() => vi.unstubAllGlobals())

    const postgres = (): Postgres => ({db, config})

    it('applies migrations once', async () => {
        expect(await migrate(db, nullLogger)).toEqual([])
        const tables = await db.query<{table_name: string}>(
            `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
        )
        expect(tables.map(t => t.table_name)).toEqual([
            'fetch_log',
            'fetch_queue',
            'package',
            'package_version',
            'registry_feed',
            'schema_migrations',
        ])
        // 0003 dropped the flag the old sqlite seed import set; 0007 the columns nothing read.
        const droppedColumns = await db.query(
            `select table_name, column_name from information_schema.columns
             where table_schema = 'public'
               and (table_name, column_name) in (('package', 'seed'), ('package', 'tracked'),
                                                 ('package_version', 'source'), ('package_version', 'fetched_at'))`,
        )
        expect(droppedColumns).toEqual([])
        const indexes = await db.query<{indexname: string}>(
            `select indexname from pg_indexes
             where schemaname = 'public' and tablename in ('package', 'fetch_queue', 'fetch_log')`,
        )
        const indexNames = indexes.map(i => i.indexname)
        expect(indexNames).toEqual(expect.arrayContaining(['package_type_key_idx', 'fetch_log_started_at_idx']))
        expect(indexNames).not.toContain('fetch_queue_ready_idx')
        expect(indexNames).not.toContain('fetch_log_package_idx')
    })

    it('deletes fetch_log rows past their retention and keeps the rest', async () => {
        await db.query('truncate fetch_log')
        await db.query(
            `insert into fetch_log (package_key, url, started_at, finished_at)
             values ('pkg:npm/old', 'https://old', now() - interval '4 days', now() - interval '4 days'),
                    (null, 'https://feed-old', now() - interval '3 days 1 hour', now() - interval '3 days 1 hour'),
                    ('pkg:npm/new', 'https://new', now() - interval '1 hour', now() - interval '1 hour')`,
        )
        expect(await pruneFetchLog(db, 3)).toBe(2)
        const left = await db.query<{url: string}>('select url from fetch_log')
        expect(left.map(r => r.url)).toEqual(['https://new'])
        expect(await pruneFetchLog(db, 3)).toBe(0)
        await db.query('truncate fetch_log')
    })

    packageWriteTests(postgres)
    feedTests(postgres)
    queueTests(postgres)
    freshnessTests(postgres)

    it('backfills freshness when 0002 lands on a database written by the old code', async () => {
        // A schema of its own, so the rows the old code would have written can be staged under
        // 0001 alone and the backfill watched as 0002 is applied on top.
        const schema = 'freshness_backfill'
        await db.query(`drop schema if exists ${schema} cascade`)
        await db.query(`create schema ${schema}`)
        const scoped = createDb(
            loadConfig({
                DATABASE_URL: `${url}${url!.includes('?') ? '&' : '?'}options=-c%20search_path%3D${schema}`,
                RESOLVER_API_TOKEN: 'x'.repeat(16),
                DATABASE_SSL: 'false',
            }),
        )
        const only0001 = mkdtempSync(path.join(tmpdir(), 'depinder-migrations-'))
        try {
            copyFileSync(path.join(migrationsDir(), '0001_init.sql'), path.join(only0001, '0001_init.sql'))
            expect(await migrate(scoped, nullLogger, only0001)).toEqual(['0001_init.sql'])

            const fetchedAt = new Date('2026-09-29T12:00:00Z')
            const cursorAt = new Date('2026-09-29T11:59:00Z')
            await scoped.query(
                `insert into package (package_key, type, name, status, fetched_at, as_of, seed, poll_etag, poll_last_modified)
                 values ('pkg:npm/fed', 'npm', 'fed', 'resolved', $1, $2, false, null, null),
                        ('pkg:maven/g/polled', 'maven', 'polled', 'resolved', $1, $1, false, '"e"', 'Mon, 28 Sep 2026 00:00:00 GMT'),
                        ('pkg:npm/seeded', 'npm', 'seeded', 'resolved', $1, $1, true, null, null),
                        ('pkg:npm/never', 'npm', 'never', 'error', null, null, false, null, null)`,
                [fetchedAt, cursorAt],
            )
            await scoped.query(
                `insert into registry_feed (type, mode, cursor, cursor_time)
                 values ('npm', 'feed', '42', $1), ('maven', 'poll', null, null)`,
                [cursorAt],
            )
            await scoped.query(`insert into fetch_queue (package_key) values ('pkg:npm/seeded')`)

            const before = new Date()
            expect(await migrate(scoped, nullLogger)).toEqual([
                '0002_package_freshness.sql',
                '0003_drop_seed.sql',
                '0004_fetch_queue_type.sql',
                '0005_fetch_queue_leased.sql',
                '0006_fetch_queue_wanted.sql',
                '0007_drop_unused_columns.sql',
                '0008_fetch_log_started_at.sql',
            ])

            const rows = new Map(
                (await scoped.query<PackageRow>('select * from package')).map(r => [r.package_key, r]),
            )
            // The frozen cursor time gives way to the fetch it was recorded with.
            expect(rows.get('pkg:npm/fed')).toMatchObject({fetched_at: fetchedAt, as_of: fetchedAt})
            // Validators the old first check took may hide a change; the next sweep takes them again.
            expect(rows.get('pkg:maven/g/polled')).toMatchObject({
                fetched_at: fetchedAt,
                as_of: fetchedAt,
                poll_etag: null,
                poll_last_modified: null,
            })
            // Depinder's cache time was never a fetch from the registry of record.
            expect(rows.get('pkg:npm/seeded')).toMatchObject({fetched_at: null, as_of: null})
            expect(rows.get('pkg:npm/never')).toMatchObject({fetched_at: null, as_of: null})
            // And 0003 then drops the flag itself.
            expect(rows.get('pkg:npm/seeded')).not.toHaveProperty('seed')

            const feeds = new Map(
                (await scoped.query<{type: string; covered_since: Date | null}>('select type, covered_since from registry_feed')).map(
                    r => [r.type, r.covered_since],
                ),
            )
            // When the old cursor started is not on record, so coverage starts with the migration.
            expect(feeds.get('npm')!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000)
            expect(feeds.get('maven')).toBeNull()

            const [queued] = await scoped.query<FetchQueueRow>('select * from fetch_queue')
            expect(queued!.requests).toBe(1)
        } finally {
            rmSync(only0001, {recursive: true, force: true})
            await scoped.close()
            await db.query(`drop schema if exists ${schema} cascade`)
        }
    })
})
