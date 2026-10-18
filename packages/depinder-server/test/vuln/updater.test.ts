import {access, mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {type Logger, nullLogger} from '@depinder/core'
import type {DatabaseBuild} from '../../src/vuln/databases.js'
import {ScanError, type ScannerName} from '../../src/vuln/scanners.js'
import {judgeSmoke} from '../../src/vuln/smoke.js'
import {createStore, type Store} from '../../src/vuln/store.js'
import {type Clock, createUpdater, FIRST_RETRY_MS, type UpdaterDeps} from '../../src/vuln/updater.js'
import type {UpstreamBuild} from '../../src/vuln/upstream.js'

/**
 * One tool's loop over a real store, with the network, the scanners and the clock stubbed: what
 * the check says, what the download leaves, what the build reports and how the smoke test goes are
 * all the test's to decide.
 */

const MIN = 60_000
const INTERVAL = 30 * MIN
const OLD = '2026-10-01T10:04:05.794145908Z'
const NEW = '2026-10-01T19:00:16.340316472Z'

let dataDir: string
let store: Store

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'vuln-updater-test-'))
    store = createStore({dataDir, staleHours: {trivy: 24, grype: 72}, log: nullLogger})
    await store.open()
})

afterEach(async () => {
    await rm(dataDir, {recursive: true, force: true})
})

/** Puts a build in place the way an install does, with Trivy's files. */
async function seed(tool: ScannerName, built_at: string, upstream_id: string | null = 'sha256:old'): Promise<void> {
    const dir = await store.newStaging(tool)
    await fill(dir)
    await store.install(tool, dir, {tool, built_at, schema: '2', upstream_id, canary_findings: 160, installed_at: built_at})
}

async function fill(dir: string): Promise<void> {
    await mkdir(join(dir, 'db'), {recursive: true})
    await writeFile(join(dir, 'db', 'trivy.db'), 'x')
    await writeFile(join(dir, 'db', 'metadata.json'), '{}')
    await mkdir(join(dir, '6'), {recursive: true})
    await writeFile(join(dir, '6', 'vulnerability.db'), 'x')
}

/** A clock whose timers fire only when told to. */
function fakeClock(start = Date.parse('2026-10-01T20:00:00Z')) {
    let now = start
    const timers: {fn: () => void, ms: number}[] = []
    const clock: Clock = {
        now: () => now,
        setTimeout: (fn, ms) => {
            const timer = {fn, ms}
            timers.push(timer)
            return timer
        },
        clearTimeout: handle => {
            const at = timers.indexOf(handle as typeof timers[number])
            if (at >= 0) timers.splice(at, 1)
        },
    }
    return {
        clock,
        timers,
        /** Fires the next timer, advancing the clock by its delay, and waits for the pass and the next schedule. */
        async fire(): Promise<void> {
            const timer = timers.shift()
            if (!timer) throw new Error('no timer')
            now += timer.ms
            timer.fn()
            for (let i = 0; i < 100 && timers.length === 0; i++) await new Promise(r => setTimeout(r, 1))
        },
    }
}

interface Calls {
    downloads: number
    baselines: (number | null)[]
}

function recordingLog(): {log: Logger, lines: {level: string, msg: string, fields?: Record<string, unknown>}[]} {
    const lines: {level: string, msg: string, fields?: Record<string, unknown>}[] = []
    const log: Logger = {
        debug: (msg, fields) => lines.push({level: 'debug', msg, fields}),
        info: (msg, fields) => lines.push({level: 'info', msg, fields}),
        warn: (msg, fields) => lines.push({level: 'warn', msg, fields}),
        error: (msg, fields) => lines.push({level: 'error', msg, fields}),
        child: () => log,
    }
    return {log, lines}
}

function updater(options: {
    tool?: ScannerName
    check?: () => Promise<UpstreamBuild>
    download?: (dir: string, signal: AbortSignal) => Promise<void>
    inspect?: () => Promise<DatabaseBuild>
    smoke?: (dir: string, baseline: number | null) => Promise<number>
    free?: number
    clock?: Clock
    log?: Logger
} = {}) {
    const calls: Calls = {downloads: 0, baselines: []}
    const deps: UpdaterDeps = {
        tool: options.tool ?? 'trivy',
        store,
        check: options.check ?? (async () => ({id: 'sha256:new', built_at: '2026-10-01T19:07:13Z', exact: false})),
        download: async (dir, signal) => {
            calls.downloads++
            if (options.download) await options.download(dir, signal)
            else await fill(dir)
        },
        inspect: options.inspect ?? (async () => ({built_at: NEW, schema: '2'})),
        smoke: async (dir, baseline) => {
            calls.baselines.push(baseline)
            return options.smoke ? options.smoke(dir, baseline) : 158
        },
        freeBytes: async () => options.free ?? 100e9,
        buildBytes: 1.6e9,
        intervalMs: INTERVAL,
        clock: options.clock ?? fakeClock().clock,
        log: options.log ?? nullLogger,
    }
    return {u: createUpdater(deps), calls}
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
const stagingEmpty = async (): Promise<boolean> => (await readdir(join(dataDir, 'staging'))).length === 0

describe('updater', () => {
    it('does nothing when the publisher has the build we have', async () => {
        await seed('trivy', OLD, 'sha256:new')
        const {u, calls} = updater()
        await u.runOnce()
        expect(calls.downloads).toBe(0)
        expect(u.status()).toMatchObject({updating: false, last_error: null, upstream_built_at: '2026-10-01T19:07:13Z'})
        expect(u.status().last_ok_at).not.toBeNull()
        expect(u.status().last_check_at).not.toBeNull()
    })

    it('downloads, smoke-tests against the current build and installs a new one', async () => {
        await seed('trivy', OLD)
        const {log, lines} = recordingLog()
        const {u, calls} = updater({log})
        await u.runOnce()
        expect(calls).toEqual({downloads: 1, baselines: [160]})
        expect(store.current('trivy')?.record).toMatchObject({built_at: NEW, upstream_id: 'sha256:new', canary_findings: 158})
        expect(u.status().last_error).toBeNull()
        expect(await stagingEmpty()).toBe(true)
        expect(lines.find(l => l.msg === 'database installed')?.fields).toMatchObject({tool: 'trivy', built_at: NEW, previous: OLD})

        // And the next tick finds nothing new.
        await u.runOnce()
        expect(calls.downloads).toBe(1)
    })

    it('installs the first build with no baseline when there is none', async () => {
        const {u, calls} = updater()
        await u.runOnce()
        expect(calls.baselines).toEqual([null])
        expect(store.current('trivy')?.record.built_at).toBe(NEW)
    })

    it('does not download a Grype build whose built time is the one we have, even with no identity on record', async () => {
        await seed('grype', '2026-10-01T06:33:48Z', null)
        const {u, calls} = updater({tool: 'grype', check: async () => ({id: 'sha256:c0d0', built_at: '2026-10-01T06:33:48Z', exact: true})})
        await u.runOnce()
        expect(calls.downloads).toBe(0)
        expect(u.status().last_error).toBeNull()
    })

    const failures: [string, Parameters<typeof updater>[0], RegExp][] = [
        ['the check fails', {check: async () => {
            throw new Error('HTTP 404 from https://mirror.gcr.io/v2/nope/manifests/2')
        }}, /^check failed: HTTP 404/],
        ['the download fails', {download: async () => {
            throw new ScanError('trivy', 'exit 1 — FATAL failed to download')
        }}, /exit 1 — FATAL failed to download/],
        ['the download times out', {download: async dir => {
            await fill(dir)
            throw new ScanError('trivy', 'timeout')
        }}, /timeout/],
        ['the build is unreadable', {inspect: async () => {
            throw new Error('trivy metadata unreadable')
        }}, /metadata unreadable/],
        ['the smoke test fails', {smoke: async () => {
            throw new Error('smoke test: trivy missed 1 canary id(s)')
        }}, /missed 1 canary/],
        ['the findings drop by more than 10 %', {smoke: async (_dir, baseline) => {
            judgeSmoke('trivy', {findings: 143, missing: []}, baseline)
            return 143
        }}, /found 143 on the canaries, the current build 160/],
        ['the download is not newer', {inspect: async () => ({built_at: OLD, schema: '2'})}, /not newer than the current/],
        ['the disk is nearly full', {free: 3e9}, /^low disk: 3\.0 GB free/],
    ]
    for (const [name, options, error] of failures) {
        it(`keeps the current build when ${name}`, async () => {
            await seed('trivy', OLD)
            const {u} = updater(options)
            await u.runOnce()
            expect(store.current('trivy')?.record.built_at).toBe(OLD)
            expect(u.status().last_error).toMatch(error)
            expect(await stagingEmpty()).toBe(true)
            expect(await readdir(join(dataDir, 'trivy'))).toHaveLength(1)
        })
    }

    it('lets a regression of up to 10 % through', async () => {
        await seed('trivy', OLD)
        const {u} = updater({smoke: async (_dir, baseline) => {
            judgeSmoke('trivy', {findings: 144, missing: []}, baseline)
            return 144
        }})
        await u.runOnce()
        expect(store.current('trivy')?.record).toMatchObject({built_at: NEW, canary_findings: 144})
    })

    it('does not download a build again once it turned out not to be newer', async () => {
        await seed('trivy', OLD)
        const {u, calls} = updater({inspect: async () => ({built_at: OLD, schema: '2'})})
        await u.runOnce()
        await u.runOnce()
        expect(calls.downloads).toBe(1)
        // Nothing went wrong the second time: it was a check that found nothing to do.
        expect(u.status().last_error).toBeNull()
    })

    it('does not download when the disk is low', async () => {
        await seed('trivy', OLD)
        const {u, calls} = updater({free: 3.1e9})
        await u.runOnce()
        expect(calls.downloads).toBe(0)
    })

    it('retries after 5, 10, 20 min, then at the check interval, and goes back to the interval once it works', async () => {
        await seed('trivy', OLD)
        let broken = true
        const fake = fakeClock()
        const {u} = updater({clock: fake.clock, check: async () => {
            if (broken) throw new Error('network down')
            return {id: 'sha256:old', built_at: null, exact: false}
        }})
        u.start()
        expect(fake.timers.map(t => t.ms)).toEqual([0])
        const delays: number[] = []
        for (let i = 0; i < 5; i++) {
            await fake.fire()
            delays.push(fake.timers[0]!.ms)
        }
        expect(delays).toEqual([FIRST_RETRY_MS, 2 * FIRST_RETRY_MS, 4 * FIRST_RETRY_MS, INTERVAL, INTERVAL])
        expect(u.status().next_check_at).toBe(new Date(fake.clock.now() + INTERVAL).toISOString())

        broken = false
        await fake.fire()
        expect(fake.timers[0]!.ms).toBe(INTERVAL)
        expect(u.status().last_error).toBeNull()

        broken = true
        await fake.fire()
        expect(fake.timers[0]!.ms).toBe(FIRST_RETRY_MS)
        await u.stop()
        expect(fake.timers).toEqual([])
    })

    it('runs one update at a time', async () => {
        let finish: (() => void) | undefined
        const {u, calls} = updater({download: async dir => {
            await fill(dir)
            await new Promise<void>(r => {
                finish = r
            })
        }})
        const first = u.runOnce()
        const second = u.runOnce()
        expect(second).toBe(first)
        while (!finish) await new Promise(r => setTimeout(r, 1))
        expect(u.status().updating).toBe(true)
        finish()
        await Promise.all([first, second])
        expect(calls.downloads).toBe(1)
        expect(u.status().updating).toBe(false)
    })

    it('kills a download in flight on stop, removes its staging and records no error', async () => {
        await seed('trivy', OLD)
        let staging = ''
        const {u, calls} = updater({download: async (dir, signal) => {
            staging = dir
            await fill(dir)
            // As `runScanner` does: a signal that went off before it started counts too.
            await new Promise((_resolve, reject) => {
                if (signal.aborted) reject(new ScanError('trivy', 'aborted'))
                signal.addEventListener('abort', () => reject(new ScanError('trivy', 'aborted')))
            })
        }})
        const run = u.runOnce()
        while (calls.downloads === 0) await new Promise(r => setTimeout(r, 1))
        await u.stop()
        await run
        expect(await exists(staging)).toBe(false)
        expect(u.status()).toMatchObject({updating: false, last_error: null, next_check_at: null})
        expect(store.current('trivy')?.record.built_at).toBe(OLD)
    })
})
