import {describe, expect, it} from 'vitest'
import {BusyError, createScanLimiter} from '../../src/vuln/limiter.js'

describe('createScanLimiter', () => {
    it('hands out free slots at once', async () => {
        const limiter = createScanLimiter(2, 0)
        await limiter.acquire()
        await limiter.acquire()
        expect(limiter.stats()).toEqual({running: 2, queued: 0})
    })

    it('serves the waiting line first in, first out', async () => {
        const limiter = createScanLimiter(1, 5)
        const first = await limiter.acquire()
        const order: number[] = []
        const waiters = [1, 2, 3].map(n => limiter.acquire().then(release => {
            order.push(n)
            return release
        }))
        expect(limiter.stats()).toEqual({running: 1, queued: 3})

        first()
        const second = await waiters[0]!
        expect(limiter.stats()).toEqual({running: 1, queued: 2})
        second()
        ;(await waiters[1]!)()
        ;(await waiters[2]!)()
        expect(order).toEqual([1, 2, 3])
        expect(limiter.stats()).toEqual({running: 0, queued: 0})
    })

    it('refuses at once when the line is full', async () => {
        const limiter = createScanLimiter(1, 1)
        await limiter.acquire()
        void limiter.acquire()
        await expect(limiter.acquire()).rejects.toBeInstanceOf(BusyError)
        expect(limiter.stats()).toEqual({running: 1, queued: 1})

        const none = createScanLimiter(1, 0)
        await none.acquire()
        await expect(none.acquire()).rejects.toBeInstanceOf(BusyError)
    })

    it('takes a waiter whose caller left out of the line, and never gives it a slot', async () => {
        const limiter = createScanLimiter(1, 5)
        const release = await limiter.acquire()
        const gone = new AbortController()
        const leaving = limiter.acquire(gone.signal)
        const staying = limiter.acquire()
        expect(limiter.stats().queued).toBe(2)

        gone.abort()
        await expect(leaving).rejects.toBeDefined()
        expect(limiter.stats()).toEqual({running: 1, queued: 1})

        release()
        const next = await staying
        expect(limiter.stats()).toEqual({running: 1, queued: 0})
        next()
        expect(limiter.stats()).toEqual({running: 0, queued: 0})
    })

    it('rejects a caller that already left', async () => {
        const limiter = createScanLimiter(1, 1)
        await expect(limiter.acquire(AbortSignal.abort())).rejects.toBeDefined()
        expect(limiter.stats()).toEqual({running: 0, queued: 0})
    })

    it('releases once, however often release is called', async () => {
        const limiter = createScanLimiter(2, 5)
        const a = await limiter.acquire()
        await limiter.acquire()
        a()
        a()
        a()
        expect(limiter.stats()).toEqual({running: 1, queued: 0})

        const full = createScanLimiter(1, 5)
        const b = await full.acquire()
        const waiter = full.acquire()
        b()
        b()
        await waiter
        // The second call did not hand the slot on again or free it.
        expect(full.stats()).toEqual({running: 1, queued: 0})
    })
})
