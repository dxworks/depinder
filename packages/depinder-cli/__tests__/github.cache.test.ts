import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    advisoryDir,
    hasEcosystem,
    isStale,
    readEcosystem,
    readManifest,
    staleEcosystems,
    writeEcosystem,
} from '../src/vuln-sources/github/cache'
import {downloadEcosystems, NoTokensError, refreshEcosystems} from '../src/vuln-sources/github/download'
import {resolveEcosystems} from '../src/vuln-sources/github/ecosystems'
import {HttpResponse} from '../src/vuln-sources/github/client'

const HOUR = 3600_000

describe('advisory cache', () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-advisories-'))
    })

    afterEach(() => {
        fs.rmSync(dir, {recursive: true, force: true})
    })

    it('writes one file per ecosystem plus a manifest', () => {
        writeEcosystem(dir, 'rubygems', [{ghsa_id: 'GHSA-1'}, {ghsa_id: 'GHSA-2'}], {
            downloadedAt: '2026-09-07T10:00:00.000Z',
            lastPage: 'https://api.github.com/advisories?after=X',
        })
        expect(fs.existsSync(path.join(advisoryDir(dir), 'rubygems.json'))).toBe(true)
        expect(readEcosystem(dir, 'rubygems').map(it => it.ghsa_id)).toEqual(['GHSA-1', 'GHSA-2'])

        const manifest = readManifest(dir)
        expect(manifest.ecosystems.rubygems).toEqual({
            downloadedAt: '2026-09-07T10:00:00.000Z',
            lastPage: 'https://api.github.com/advisories?after=X',
            count: 2,
        })
    })

    it('keeps other ecosystems when one is rewritten', () => {
        writeEcosystem(dir, 'npm', [{ghsa_id: 'GHSA-n'}], {downloadedAt: new Date().toISOString()})
        writeEcosystem(dir, 'rubygems', [{ghsa_id: 'GHSA-r'}], {downloadedAt: new Date().toISOString()})
        expect(Object.keys(readManifest(dir).ecosystems).sort()).toEqual(['npm', 'rubygems'])
    })

    it('treats a truncated manifest as an empty cache rather than throwing', () => {
        fs.mkdirSync(advisoryDir(dir), {recursive: true})
        fs.writeFileSync(path.join(advisoryDir(dir), 'manifest.json'), '{ not json')
        expect(readManifest(dir).ecosystems).toEqual({})
    })

    it('calls an ecosystem stale when it is missing, old, or incomplete', () => {
        const now = Date.parse('2026-09-07T12:00:00.000Z')
        const manifest = {
            version: 1 as const,
            ecosystems: {
                fresh: {downloadedAt: '2026-09-07T06:00:00.000Z', count: 10},
                old: {downloadedAt: '2026-09-05T06:00:00.000Z', count: 10},
                broken: {downloadedAt: '2026-09-07T11:00:00.000Z', count: 3, error: 'HTTP 500'},
                unparseable: {downloadedAt: 'not a date', count: 1},
            },
        }
        expect(isStale(manifest, 'fresh', 24, now)).toBe(false)
        expect(isStale(manifest, 'old', 24, now)).toBe(true)
        expect(isStale(manifest, 'broken', 24, now)).toBe(true)
        expect(isStale(manifest, 'unparseable', 24, now)).toBe(true)
        expect(isStale(manifest, 'never-downloaded', 24, now)).toBe(true)
    })

    it('scopes refresh to what is missing or old on disk', () => {
        const now = Date.now()
        writeEcosystem(dir, 'rubygems', [], {downloadedAt: new Date(now - HOUR).toISOString()})
        writeEcosystem(dir, 'npm', [], {downloadedAt: new Date(now - 48 * HOUR).toISOString()})
        expect(staleEcosystems(dir, ['rubygems', 'npm', 'maven'], 24, now).sort()).toEqual(['maven', 'npm'])
        expect(hasEcosystem(dir, 'rubygems')).toBe(true)
        expect(hasEcosystem(dir, 'maven')).toBe(false)
    })
})

describe('downloadEcosystems', () => {
    let dir: string

    // The pool is read from the environment when no token file exists, which is how these tests
    // get a token without one on disk. Every test supplies its own `fetch`, so nothing this file
    // runs ever opens a socket.
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-download-'))
        process.env.GH_TOKEN_1 = 'pool-token-1'
    })

    afterEach(() => {
        delete process.env.GH_TOKEN_1
        fs.rmSync(dir, {recursive: true, force: true})
    })

    const noSleep = async (): Promise<void> => undefined

    function page(body: unknown, next?: string): HttpResponse {
        return {
            status: 200,
            headers: {'x-ratelimit-remaining': '4999', ...(next ? {link: `<${next}>; rel="next"`} : {})},
            body: JSON.stringify(body),
        }
    }

    it('downloads each ecosystem into its own file and reports token usage', async () => {
        const {resolved} = resolveEcosystems(['rubygems', 'npm'])
        const report = await downloadEcosystems(resolved, {
            cacheDir: dir,
            tokenFile: 'no-such-file',
            sleep: noSleep,
            fetch: async url => {
                const ecosystem = /ecosystem=([a-z]+)/.exec(url)?.[1] ?? 'unknown'
                return page([{ghsa_id: `GHSA-${ecosystem}`}])
            },
        })

        expect(report.results.map(it => it.ecosystem).sort()).toEqual(['npm', 'rubygems'])
        expect(readEcosystem(dir, 'npm')[0].ghsa_id).toBe('GHSA-npm')
        expect(readEcosystem(dir, 'rubygems')[0].ghsa_id).toBe('GHSA-rubygems')
        expect(report.tokenUsage[0].requests).toBe(2)
        expect(report.tokenUsage[0].token).not.toContain('pool-token')
    })

    it('keeps a partial download and records the error, so the next run retries it', async () => {
        const {resolved} = resolveEcosystems(['rubygems'])
        let call = 0
        const report = await downloadEcosystems(resolved, {
            cacheDir: dir,
            tokenFile: 'no-such-file',
            sleep: noSleep,
            maxAttempts: 2,
            fetch: async () => {
                call++
                if (call === 1) return page([{ghsa_id: 'GHSA-1'}], 'https://api.github.com/advisories?after=P2')
                return {status: 500, headers: {}, body: 'boom'}
            },
        })

        expect(report.results[0].error).toMatch(/HTTP 500/)
        expect(readEcosystem(dir, 'rubygems')).toHaveLength(1)
        expect(readManifest(dir).ecosystems.rubygems.error).toMatch(/HTTP 500/)
        expect(staleEcosystems(dir, ['rubygems'])).toEqual(['rubygems'])
    })

    it('says what to do when the pool is empty instead of failing obscurely', async () => {
        delete process.env.GH_TOKEN_1
        const {resolved} = resolveEcosystems(['rubygems'])
        // No fetch is supplied on purpose: the pool must be found empty before anything is sent.
        await expect(downloadEcosystems(resolved, {cacheDir: dir, tokenFile: 'no-such-file'}))
            .rejects.toThrow(NoTokensError)
    })

    it('downloads nothing when every requested ecosystem is cached and fresh', async () => {
        writeEcosystem(dir, 'rubygems', [], {downloadedAt: new Date().toISOString()})
        const report = await refreshEcosystems(['rubygems'], 24, {cacheDir: dir, tokenFile: 'no-such-file'})
        expect(report).toBeUndefined()
    })
})
