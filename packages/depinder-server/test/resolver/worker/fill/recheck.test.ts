import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nullLogger} from '@depinder/core'
import {PRIORITY} from '../../../../src/resolver/db/queue.js'
import {recheckAfterMs, registries} from '../../../../src/resolver/registries/index.js'
import {resetLimiters} from '../../../../src/resolver/registries/http.js'
import {runOnce} from '../../../../src/resolver/worker/fill/pool.js'
import {MAX_ATTEMPTS} from '../../../../src/resolver/worker/fill/retry.js'
import {settleQueueRow} from '../../../../src/resolver/worker/fill/write.js'
import {config, recordingDb, resetCounters, stubPackument} from './fill.helpers.js'

/**
 * The second look after a feed-triggered fetch: how long each ecosystem waits for it, and how the
 * package write schedules it. The statement runs against Postgres in `db.integration.test.ts`;
 * here, what the worker hands it.
 */

beforeEach(() => {
    resetCounters()
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const MINUTE = 60_000

describe('recheckAfterMs', () => {
    it('outlasts each feed ecosystem\'s registry cache', () => {
        expect(recheckAfterMs('npm')).toBe(6 * MINUTE)
        expect(recheckAfterMs('gem')).toBe(3 * MINUTE)
        expect(recheckAfterMs('golang')).toBe(2 * MINUTE)
        expect(recheckAfterMs('nuget')).toBe(15 * MINUTE)
        expect(recheckAfterMs('pypi')).toBe(16 * MINUTE)
        expect(recheckAfterMs('composer')).toBe(16 * MINUTE)
    })

    it('is nothing for the poll ecosystems, and every feed ecosystem has one', () => {
        expect(recheckAfterMs('maven')).toBe(0)
        expect(recheckAfterMs('cargo')).toBe(0)
        for (const registry of Object.values(registries)) {
            if (registry.feed.mode === 'feed') expect(registry.feed.recheckAfterMs).toBeGreaterThan(0)
        }
    })
})

describe('settleQueueRow', () => {
    const withRecheck = settleQueueRow('$13', '$15')

    it('deletes the row only when no feed event is waiting on it and no second look is ahead', () => {
        expect(withRecheck).toMatch(
            /done as \(delete from fetch_queue\s+where package_key = \$1 and requests = \$13::int\s+and not feed_event\s+and \(recheck_at is null or recheck_at <= now\(\)\)\)/,
        )
    })

    it('schedules a feed-triggered fetch\'s second look, ranked as one and wanted by nobody', () => {
        const scheduled = withRecheck.slice(withRecheck.indexOf('scheduled as'), withRecheck.indexOf('resumed as'))
        expect(scheduled).toContain('recheck_at      = now() + make_interval(secs => $15::double precision)')
        expect(scheduled).toContain('next_attempt_at = now() + make_interval(secs => $15::double precision)')
        expect(scheduled).toContain(`priority        = ${PRIORITY.recheck}`)
        // Cleared, so the second look does not schedule a third unless a new event sets it again.
        expect(scheduled).toContain('feed_event      = false')
        expect(scheduled).toContain('wanted_until    = null')
        expect(scheduled).toMatch(/where package_key = \$1 and requests = \$13::int\s+and feed_event\)/)
    })

    it('hands a row whose second look a request jumped back to that look', () => {
        const resumed = withRecheck.slice(withRecheck.indexOf('resumed as'))
        expect(resumed).toMatch(/set next_attempt_at = recheck_at,/)
        expect(resumed).toMatch(/and not feed_event\s+and recheck_at > now\(\)\)/)
    })

    it('still makes a row asked for again mid-fetch due at once, keeping what it owes', () => {
        const askedAgain = withRecheck.slice(withRecheck.lastIndexOf('update fetch_queue'))
        expect(askedAgain).toMatch(/set next_attempt_at = now\(\),\s+attempts\s+= 0,\s+leased\s+= false\s+where package_key = \$1\s+and requests <> \$13::int$/)
    })

    it('owes nothing without a settle time: the row goes whatever a feed said', () => {
        const plain = settleQueueRow('$2')
        expect(plain).not.toMatch(/feed_event|recheck_at/)
        expect(plain).toMatch(/^done as \(delete from fetch_queue where package_key = \$1 and requests = \$2::int\)/)
    })
})

describe('the package write', () => {
    it('carries its ecosystem\'s settle time, in seconds', async () => {
        const {db, statements} = recordingDb(['pkg:npm/one'])
        stubPackument(['1.0.0'])

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const upsert = statements.find(s => s.text.includes('insert into package '))!
        expect(upsert.text).toContain('scheduled as (update fetch_queue')
        expect(upsert.params[14]).toBe(360)
    })

    it('carries it for a package the registry has never heard of too', async () => {
        const {db, statements} = recordingDb(['pkg:npm/gone'])
        stubPackument(null)

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const notFound = statements.find(s => s.text.includes("'not_found'"))!
        expect(notFound.text).toContain('scheduled as (update fetch_queue')
        expect(notFound.params[6]).toBe(360)
    })

    it('owes no second look once it gives up: the sweeper retries an hour later', async () => {
        const {db, statements} = recordingDb(['pkg:npm/broken'], undefined, MAX_ATTEMPTS - 1)
        vi.stubGlobal('fetch', async () =>
            new Response('{}', {status: 500, headers: {'content-type': 'application/json'}}))

        await runOnce({db, log: nullLogger, config, poolSize: 1})

        const settle = statements.find(s => s.text.includes('delete from fetch_queue'))!
        expect(settle.text).not.toMatch(/feed_event|recheck_at/)
    })
})
