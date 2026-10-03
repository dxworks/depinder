import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {nullLogger} from '../../../src/shared/log.js'
import {registries} from '../../../src/resolver/registries/index.js'
import {firstRunDelayMs, POLL_FIRST_SWEEP_MS} from '../../../src/resolver/worker/feeds.js'
import {startLoop} from '../../../src/resolver/worker/loop.js'

/**
 * When each registry's loop first runs. Poll mode (maven, cargo) measures its lag from the last
 * successful sweep, so a first sweep one six-hour interval after boot would mean `/feeds` reports
 * no lag at all for six hours every time the worker restarts.
 */
describe('firstRunDelayMs', () => {
    it('sweeps poll-mode registries a minute after boot, not an interval later', () => {
        for (const type of ['maven', 'cargo']) {
            const feed = registries[type]!.feed
            expect(feed.mode).toBe('poll')
            expect(feed.intervalMs).toBe(6 * 60 * 60 * 1000)
            expect(firstRunDelayMs(feed)).toBe(POLL_FIRST_SWEEP_MS)
        }
    })

    it('lets feed-mode registries wait one interval', () => {
        for (const registry of Object.values(registries)) {
            if (registry.feed.mode !== 'feed') continue
            expect(firstRunDelayMs(registry.feed)).toBe(registry.feed.intervalMs)
        }
        expect(firstRunDelayMs(registries.npm!.feed)).toBe(30_000)
        expect(firstRunDelayMs(registries.gem!.feed)).toBe(120_000)
    })

    it('never delays past the interval itself', () => {
        expect(firstRunDelayMs({mode: 'poll', intervalMs: 5_000, check: async () => ({changed: false, confirmed: false})})).toBe(5_000)
    })
})

describe('startLoop', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('waits initialDelayMs for the first run, then runs every interval', async () => {
        let runs = 0
        const loop = startLoop({
            name: 'poll:test',
            intervalMs: 6 * 60 * 60 * 1000,
            log: nullLogger,
            run: async () => {
                runs++
            },
            initialDelayMs: POLL_FIRST_SWEEP_MS,
        })

        await vi.advanceTimersByTimeAsync(POLL_FIRST_SWEEP_MS - 1)
        expect(runs).toBe(0)
        await vi.advanceTimersByTimeAsync(1)
        expect(runs).toBe(1)

        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
        expect(runs).toBe(2)

        await loop.stop()
        await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000)
        expect(runs).toBe(2)
    })

    it('runs immediately when no initial delay is given', async () => {
        let runs = 0
        const loop = startLoop({
            name: 'immediate',
            intervalMs: 1_000,
            log: nullLogger,
            run: async () => {
                runs++
            },
        })

        await vi.advanceTimersByTimeAsync(0)
        expect(runs).toBe(1)
        await loop.stop()
    })

    it('keeps going after a throwing tick', async () => {
        let runs = 0
        const loop = startLoop({
            name: 'flaky',
            intervalMs: 1_000,
            log: nullLogger,
            run: async () => {
                runs++
                throw new Error('registry is down')
            },
        })

        await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(runs).toBe(2)
        await loop.stop()
    })
})
