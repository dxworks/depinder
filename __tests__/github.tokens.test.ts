import fs from 'fs'
import os from 'os'
import path from 'path'
import {loadTokens, maskToken, parseTokenFile, TokenPool} from '../src/vuln-sources/github/tokens'

describe('parseTokenFile', () => {
    it('reads dotenv shapes: comments, blanks, export, quotes', () => {
        const parsed = parseTokenFile([
            '# a comment',
            '',
            'GH_TOKEN_1=ghp_one',
            'export GH_TOKEN_2="ghp_two"',
            "GH_TOKEN_3 = 'ghp_three'",
            'NOT_A_TOKEN=ignored-by-the-caller',
            'malformed line without equals',
        ].join('\n'))
        expect(parsed.get('GH_TOKEN_1')).toBe('ghp_one')
        expect(parsed.get('GH_TOKEN_2')).toBe('ghp_two')
        expect(parsed.get('GH_TOKEN_3')).toBe('ghp_three')
        expect(parsed.has('malformed line without equals')).toBe(false)
    })
})

describe('loadTokens', () => {
    let dir: string
    let cwd: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-tokens-'))
        cwd = process.cwd()
        process.chdir(dir)
    })

    afterEach(() => {
        process.chdir(cwd)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    it('collects a contiguous numbered pool and stops at the first gap', () => {
        fs.writeFileSync('.github-tokens', 'GH_TOKEN_1=a\nGH_TOKEN_2=b\nGH_TOKEN_4=d\n')
        expect(loadTokens('.github-tokens', {})).toEqual(['a', 'b'])
    })

    it('accepts a bare GH_TOKEN as a pool of one', () => {
        expect(loadTokens('.github-tokens', {GH_TOKEN: 'solo'})).toEqual(['solo'])
    })

    it('appends a bare GH_TOKEN after the numbered pool, without duplicating it', () => {
        fs.writeFileSync('.github-tokens', 'GH_TOKEN_1=a\nGH_TOKEN=a\n')
        expect(loadTokens('.github-tokens', {})).toEqual(['a'])
        fs.writeFileSync('.github-tokens', 'GH_TOKEN_1=a\nGH_TOKEN=z\n')
        expect(loadTokens('.github-tokens', {})).toEqual(['a', 'z'])
    })

    it('lets the file win over the environment for the same key', () => {
        fs.writeFileSync('.github-tokens', 'GH_TOKEN_1=from-file\n')
        expect(loadTokens('.github-tokens', {GH_TOKEN_1: 'from-env'})).toEqual(['from-file'])
    })

    it('falls back to the environment when the file does not exist', () => {
        expect(loadTokens('.github-tokens', {GH_TOKEN_1: 'a', GH_TOKEN_2: 'b'})).toEqual(['a', 'b'])
    })

    it('returns an empty pool rather than throwing when there is nothing to read', () => {
        expect(loadTokens('.github-tokens', {})).toEqual([])
    })
})

describe('maskToken', () => {
    it('never reveals the middle of a token', () => {
        const masked = maskToken('ghp_abcdefghijklmnop')
        expect(masked).not.toContain('efghijkl')
        expect(masked.startsWith('ghp_')).toBe(true)
    })
})

describe('TokenPool', () => {
    /** A clock and a sleep the test drives, so parking does not really take an hour. */
    function fakeClock(): {now: () => number, sleep: (ms: number) => Promise<void>, advance: (ms: number) => void} {
        let time = 1_000_000
        return {
            now: () => time,
            sleep: async (ms: number) => {
                time += ms
            },
            advance: (ms: number) => {
                time += ms
            },
        }
    }

    it('rotates round-robin over free tokens', async () => {
        const pool = new TokenPool(['a', 'b', 'c'], fakeClock())
        const order: string[] = []
        for (let i = 0; i < 6; i++) {
            const token = await pool.acquire()
            order.push(token)
            pool.release(token)
        }
        expect(order).toEqual(['a', 'b', 'c', 'a', 'b', 'c'])
    })

    it('hands out one token at a time, so the pool size bounds concurrency', async () => {
        const pool = new TokenPool(['a'], fakeClock())
        const first = await pool.acquire()
        let second: string | undefined
        const pending = pool.acquire().then(t => {
            second = t
        })
        expect(second).toBeUndefined()
        pool.release(first)
        await pending
        expect(second).toBe('a')
    })

    it('parks a token once its remaining budget reaches the safety margin', async () => {
        const clock = fakeClock()
        const pool = new TokenPool(['a', 'b'], {...clock, safetyMargin: 10})
        const token = await pool.acquire()
        expect(token).toBe('a')
        pool.observe('a', {
            'x-ratelimit-remaining': '5',
            'x-ratelimit-reset': String(Math.floor((clock.now() + 3600_000) / 1000)),
        })
        pool.release('a')

        // 'a' is parked for the rest of the window, so every acquire lands on 'b'.
        for (let i = 0; i < 3; i++) {
            const next = await pool.acquire()
            expect(next).toBe('b')
            pool.release(next)
        }
        expect(pool.usage().find(it => it.requests === 1)?.parked).toBe(1)
    })

    it('waits for the window to reset when every token is parked', async () => {
        const clock = fakeClock()
        const pool = new TokenPool(['a'], {...clock, safetyMargin: 10})
        const first = await pool.acquire()
        pool.observe(first, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor((clock.now() + 5000) / 1000)),
        })
        pool.release(first)
        const before = clock.now()
        const next = await pool.acquire()
        expect(next).toBe('a')
        expect(clock.now()).toBeGreaterThanOrEqual(before + 4000)
    })

    it('caps concurrency at 4 however many tokens there are', () => {
        expect(new TokenPool(['a']).concurrency).toBe(1)
        expect(new TokenPool(['a', 'b', 'c']).concurrency).toBe(3)
        expect(new TokenPool(['a', 'b', 'c', 'd', 'e', 'f']).concurrency).toBe(4)
    })

    it('reports masked per-token usage', async () => {
        const pool = new TokenPool(['ghp_aaaaaaaaaaaa', 'ghp_bbbbbbbbbbbb'], fakeClock())
        const token = await pool.acquire()
        pool.observe(token, {'x-ratelimit-remaining': '4999'})
        pool.release(token)
        const usage = pool.usage()
        expect(usage).toHaveLength(2)
        expect(usage[0]).toMatchObject({requests: 1, remaining: 4999, parked: 0})
        expect(usage[0].token).not.toContain('aaaaaaaaaaaa')
    })
})
