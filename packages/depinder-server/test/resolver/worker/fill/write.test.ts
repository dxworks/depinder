import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resetLimiters, sleep} from '../../../../src/resolver/registries/http.js'
import {nullLogger} from '../../../../src/shared/log.js'
import {createResolverEvents} from '../../../../src/resolver/events.js'
import {runOnce} from '../../../../src/resolver/worker/fill/pool.js'
import {MAX_ATTEMPTS} from '../../../../src/resolver/worker/fill/retry.js'
import {VERSION_CHUNK} from '../../../../src/resolver/worker/fill/write.js'
import {
    BOUNDARIES,
    config,
    packument,
    recordingDb,
    resetCounters,
    stubPackument,
    versionStatements,
    type Statement,
} from './fill.helpers.js'

/**
 * The demand-fill worker's write path: what one package costs against a hosted database, which is
 * counted in statements rather than in rows. Those tests read the statements the worker issues —
 * their order, their transaction, and the arrays they carry — because the SQL itself can only be
 * run by `db.integration.test.ts`.
 */

beforeEach(() => {
    resetCounters()
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('demand-fill write path', () => {
    it('writes a package, its versions and its provenance in five statements', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        stubPackument(['1.0.0', '2.0.0'])

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        // The dequeue is per pass, and the pool amortises it, so what a package costs is everything
        // from `begin` onwards. Nothing reads registry_feed: a fetch vouches for itself alone.
        expect(statements.map(s => s.text)).toEqual([
            expect.stringContaining('update fetch_queue q'),
            'begin',
            expect.stringContaining('insert into package '),
            expect.stringContaining('insert into package_version'),
            expect.stringContaining('insert into fetch_log'),
            'commit',
        ])
        // The queue row leaves with the package rather than in a round trip of its own.
        expect(statements[2]!.text).toContain('delete from fetch_queue')
    })

    it('removes the versions the registry no longer lists, in the statement that writes the rest', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        stubPackument(['1.0.0', '2.0.0'])

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const [write, ...rest] = versionStatements(statements)
        expect(rest).toEqual([])
        // Every row of this package that the registry did not just list goes; the ones it did are
        // refreshed rather than skipped, so a re-release or a yank is not lost.
        expect(write!.text).toContain('delete from package_version')
        expect(write!.text).toMatch(/purl not in \(select unnest\(\$10::text\[]\)\)/)
        expect(write!.text).toContain('on conflict (purl) do update')
        expect(write!.params[0]).toBe('pkg:npm/one')
        expect(write!.params[9]).toEqual(['pkg:npm/one@1.0.0', 'pkg:npm/one@2.0.0'])
        expect(write!.params[1]).toEqual(['pkg:npm/one@1.0.0', 'pkg:npm/one@2.0.0'])
    })

    it('splits a version list past the chunk and still deletes stale rows exactly once', async () => {
        const versions = Array.from({length: VERSION_CHUNK + 1}, (_, i) => `1.0.${i}`)
        const {db, statements} = recordingDb(['pkg:npm/one'])
        stubPackument(versions)

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const writes = versionStatements(statements)
        expect(writes).toHaveLength(2)
        expect(writes[0]!.text).toContain('delete from package_version')
        expect(writes[1]!.text).not.toContain('delete from package_version')
        // Only the first statement carries the list to keep; the second is an upsert and nothing else.
        expect(writes[0]!.params).toHaveLength(10)
        expect(writes[1]!.params).toHaveLength(9)

        const first = writes[0]!.params[1] as string[]
        const second = writes[1]!.params[1] as string[]
        expect(first).toHaveLength(VERSION_CHUNK)
        expect(second).toHaveLength(1)
        // The delete is told the whole list rather than its own chunk, so it cannot take away the
        // rows the second statement is about to write.
        expect(writes[0]!.params[9]).toEqual([...first, ...second])
    })

    it('takes the last versions away when the registry lists none', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        stubPackument([])

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const [write, ...rest] = versionStatements(statements)
        expect(rest).toEqual([])
        expect(write!.text).toBe('delete from package_version where package_key = $1')
        expect(write!.params).toEqual(['pkg:npm/one'])
    })

    it('rolls the whole package back when the version write fails, and leaves it to be retried', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'], text => text.includes('insert into package_version'))
        stubPackument(['1.0.0'])

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        // The package, its versions and the queue delete share one transaction, so a failed version
        // write takes all three with it. The retry is then recorded in a transaction of its own.
        expect(statements.filter(s => BOUNDARIES.includes(s.text)).map(s => s.text)).toEqual([
            'begin',
            'rollback',
            'begin',
            'commit',
        ])
        // Including the queue delete: it was issued inside that transaction, so it went back too.
        const texts = statements.map(s => s.text)
        const queueDelete = texts.findIndex(t => t.includes('delete from fetch_queue'))
        expect(queueDelete).toBeGreaterThan(texts.indexOf('begin'))
        expect(queueDelete).toBeLessThan(texts.indexOf('rollback'))

        const retry = statements.find(s => s.text.includes('set attempts'))
        expect(retry?.params).toEqual(['pkg:npm/one', 1, 30, 'write failed'])
    })

    it('stamps fetched_at and as_of with the time the fetch started, in every ecosystem', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        let answeredAt = 0
        vi.stubGlobal('fetch', async (input: string | URL) => {
            await sleep(20)
            answeredAt = Date.now()
            const name = String(input).slice(String(input).lastIndexOf('/') + 1)
            return new Response(JSON.stringify(packument(name)), {
                status: 200,
                headers: {'content-type': 'application/json'},
            })
        })
        const before = Date.now()

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const upsert = statements.find(s => s.text.includes('insert into package '))!
        // One parameter for both columns: a full fetch is the only thing vouching for the facts.
        expect(upsert.text).toContain("'resolved', null, $11, $12, $12, $14")
        // npm never asks for a re-check, so next_retry_at is cleared.
        expect(upsert.params[13]).toBeNull()
        const fetchedAt = (upsert.params[11] as Date).getTime()
        expect(fetchedAt).toBeGreaterThanOrEqual(before)
        expect(fetchedAt).toBeLessThan(answeredAt)
    })

    it('drops the queue row only if nobody asked for the package again while it was fetched', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        stubPackument(['1.0.0'])

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const upsert = statements.find(s => s.text.includes('insert into package '))!
        // The count that was dequeued travels with the write; a row whose count has moved since is
        // made due again instead of deleted.
        expect(upsert.text).toContain('requests = $13::int')
        expect(upsert.text).toMatch(/set next_attempt_at = now\(\),\s+attempts\s+= 0,\s+leased\s+= false\s+where package_key = \$1\s+and requests <> \$13::int/)
        expect(upsert.params[12]).toBe(1)
    })

    it('clears the queue row for a package the registry has never heard of', async () => {
        const {db, statements} = recordingDb(['pkg:npm/gone'])
        stubPackument(null)

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        expect(statements.map(s => s.text)).toEqual([
            expect.stringContaining('update fetch_queue q'),
            'begin',
            expect.stringContaining("'not_found'"),
            expect.stringContaining('insert into fetch_log'),
            'commit',
        ])
        expect(statements[2]!.text).toContain('delete from fetch_queue')
        // A registry's "no such package" is a full answer too: both timestamps, one parameter.
        expect(statements[2]!.text).toContain("'not_found', null, $5, $5,")
        expect(statements[2]!.params[4]).toBeInstanceOf(Date)
    })
})

describe('what the worker tells the api', () => {
    /** Subscribes, and remembers the statement that had just been issued when each event arrived. */
    function listen(statements: readonly Statement[]): {events: ReturnType<typeof createResolverEvents>; settled: string[]; at: string[]} {
        const events = createResolverEvents()
        const settled: string[] = []
        const at: string[] = []
        events.onSettled(key => {
            settled.push(key)
            at.push(statements[statements.length - 1]?.text ?? 'nothing')
        })
        return {events, settled, at}
    }

    it('announces a resolved package once its transaction has committed', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        const {events, settled, at} = listen(statements)
        stubPackument(['1.0.0'])

        await runOnce({db, log: nullLogger, config, poolSize: 1, events})

        expect(settled).toEqual(['pkg:npm/one'])
        // Inside the transaction the row is not there to be read, so `commit` must already have
        // been issued when the api hears about it.
        expect(at).toEqual(['commit'])
    })

    it('announces a package the registry has never heard of', async () => {
        const {db, statements} = recordingDb(['pkg:npm/gone'])
        const {events, settled, at} = listen(statements)
        stubPackument(null)

        await runOnce({db, log: nullLogger, config, poolSize: 1, events})

        // `not_found` is terminal: a request waiting on it has its answer.
        expect(settled).toEqual(['pkg:npm/gone'])
        expect(at).toEqual(['commit'])
    })

    it('announces a package it has given up on', async () => {
        const {db, statements} = recordingDb(['pkg:npm/broken'], undefined, MAX_ATTEMPTS - 1)
        const {events, settled, at} = listen(statements)
        vi.stubGlobal('fetch', async () =>
            new Response('{}', {status: 500, headers: {'content-type': 'application/json'}}))

        await runOnce({db, log: nullLogger, config, poolSize: 1, events})

        expect(settled).toEqual(['pkg:npm/broken'])
        expect(at).toEqual(['commit'])
    })

    it('says nothing about a failure it is going to retry', async () => {
        const {db, statements} = recordingDb(['pkg:npm/flaky'])
        const {events, settled} = listen(statements)
        vi.stubGlobal('fetch', async () =>
            new Response('{}', {status: 500, headers: {'content-type': 'application/json'}}))

        await runOnce({db, log: nullLogger, config, poolSize: 1, events})

        // The package is still pending, so there is nothing to tell a waiting request.
        expect(settled).toEqual([])
    })
})
