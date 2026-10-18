import {describe, expect, it} from 'vitest'
import {createLimiter, createLimiterPool, limitFor} from '../../src/http/limiter.js'

describe('limiter', () => {
    it('never runs more than `concurrency` at once', async () => {
        const limit = createLimiter({concurrency: 2, minIntervalMs: 0})
        let active = 0
        let peak = 0

        await Promise.all(
            Array.from({length: 6}, () =>
                limit.run(async () => {
                    active++
                    peak = Math.max(peak, active)
                    await new Promise(resolve => setTimeout(resolve, 5))
                    active--
                }),
            ),
        )

        expect(peak).toBe(2)
        expect(active).toBe(0)
    })

    it('spaces starts by minIntervalMs', async () => {
        const limit = createLimiter({concurrency: 1, minIntervalMs: 20})
        const starts: number[] = []
        const begin = Date.now()

        await Promise.all(Array.from({length: 3}, () => limit.run(async () => void starts.push(Date.now() - begin))))

        expect(starts).toHaveLength(3)
        // Each start is reserved at a fixed offset from the first, not from the one before: a start
        // the event loop ran late does not push the next one back, so measure from the beginning.
        expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(18)
        expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(38)
    })

    it('releases its slot when the task throws', async () => {
        const limit = createLimiter({concurrency: 1, minIntervalMs: 0})
        await expect(limit.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
        await expect(limit.run(async () => 'fine')).resolves.toBe('fine')
    })

    /** Holds a one-slot limiter while `tags` queue behind it; returns the order the waiters ran in. */
    async function order(pick: (waiting: readonly (string | undefined)[]) => number, tags: string[]): Promise<string[]> {
        const limit = createLimiter<string>({concurrency: 1, minIntervalMs: 0}, pick)
        let release!: () => void
        const held = limit.run(() => new Promise<void>(resolve => (release = resolve)))
        const ran: string[] = []
        const waiting = tags.map(tag => limit.run(async () => void ran.push(tag), tag))
        await new Promise(resolve => setTimeout(resolve, 0)) // the first task is running and holds `release`
        release()
        await Promise.all([held, ...waiting])
        return ran
    }

    it('serves waiters first come, first served by default', async () => {
        expect(await order(() => 0, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
    })

    it('lets the caller pick who goes next from the waiting tags', async () => {
        const lastFirst = (waiting: readonly (string | undefined)[]) => waiting.length - 1
        expect(await order(lastFirst, ['a', 'b', 'c'])).toEqual(['c', 'b', 'a'])
    })
})

describe('limiter pool', () => {
    const limits = {byType: {cargo: {concurrency: 1, minIntervalMs: 1000}}, fallback: {concurrency: 8, minIntervalMs: 0}}

    it("uses the caller's limits: a type's own row, else the fallback", () => {
        const pool = createLimiterPool(limits)
        expect(pool.forType('cargo').spec).toEqual({concurrency: 1, minIntervalMs: 1000})
        expect(pool.forType('npm').spec).toEqual(limits.fallback)
        expect(limitFor(limits, 'gem')).toEqual(limits.fallback)
    })

    it('shares one limiter per type until reset', () => {
        const pool = createLimiterPool(limits)
        const npm = pool.forType('npm')
        expect(pool.forType('npm')).toBe(npm)
        pool.reset()
        expect(pool.forType('npm')).not.toBe(npm)
    })

    it('gives every limiter a picker of its own', () => {
        let made = 0
        const pool = createLimiterPool(limits, () => {
            made++
            return () => 0
        })
        pool.forType('npm')
        pool.forType('pypi')
        pool.forType('npm')
        expect(made).toBe(2)
    })
})
