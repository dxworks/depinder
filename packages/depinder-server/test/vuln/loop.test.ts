import {describe, expect, it} from 'vitest'
import {nullLogger} from '@depinder/core'
import {createLoop, createMutex} from '../../src/vuln/loop.js'

/** The schedule itself is covered through the database updater (`updater.test.ts`); this is the lock. */

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 1))

describe('one tool\'s lock', () => {
    it('runs a database pass and a scanner pass one after the other, never at once', async () => {
        const lock = createMutex()
        const order: string[] = []
        let release: (() => void) | undefined
        const loop = (name: string, hold: boolean) => createLoop({
            name, fields: {tool: 'trivy'}, intervalMs: 60_000, log: nullLogger, lock,
            attempt: async () => {
                order.push(`${name} start`)
                if (hold) await new Promise<void>(r => {
                    release = r
                })
                order.push(`${name} end`)
            },
        })
        const database = loop('database', true)
        const scanner = loop('scanner', false)

        const first = database.runOnce()
        while (!release) await tick()
        const second = scanner.runOnce()
        await tick()
        // Waiting for the lock counts as updating.
        expect(scanner.status().updating).toBe(true)
        expect(order).toEqual(['database start'])

        release()
        await Promise.all([first, second])
        expect(order).toEqual(['database start', 'database end', 'scanner start', 'scanner end'])
    })

    it('does not start a pass that was stopped while it waited for the lock', async () => {
        const lock = createMutex()
        let release: (() => void) | undefined
        const held = lock.run(() => new Promise<void>(r => {
            release = r
        }))
        let ran = false
        const loop = createLoop({
            name: 'scanner update', fields: {}, intervalMs: 60_000, log: nullLogger, lock,
            attempt: async () => {
                ran = true
            },
        })
        while (!release) await tick()
        const pass = loop.runOnce()
        const stopped = loop.stop()
        release()
        await Promise.all([held, pass, stopped])
        expect(ran).toBe(false)
        expect(loop.status().last_error).toBeNull()
    })

    it('lets the next holder in after one fails', async () => {
        const lock = createMutex()
        await expect(lock.run(async () => {
            throw new Error('boom')
        })).rejects.toThrow('boom')
        await expect(lock.run(async () => 'next')).resolves.toBe('next')
    })
})
