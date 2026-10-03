import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHttpClient, resetLimiters, type FetchRecord} from '../../../src/resolver/registries/http.js'
import {computeLatest} from '../../../src/resolver/registries/latest.js'
import {type Logger, nullLogger, parsePurl} from '@depinder/core'
import {composerRegistry, expandMinified, packageFromMetadata} from '../../../src/resolver/registries/composer.js'
import type {FetchContext} from '../../../src/resolver/registries/types.js'

const fixture = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>

const monolog = fixture('composer-monolog')
const monologDev = fixture('composer-monolog-dev')
const changes = fixture('composer-changes')
const changesResync = fixture('composer-changes-resync')

const MAIN_URL = 'https://repo.packagist.org/p2/monolog/monolog.json'
const DEV_URL = 'https://repo.packagist.org/p2/monolog/monolog~dev.json'

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]
let records: FetchRecord[]
let warnings: {msg: string; fields?: Record<string, unknown>}[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({url, init})
        return Promise.resolve(handler(url))
    })
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

const capturingLogger: Logger = {
    ...nullLogger,
    warn: (msg, fields) => warnings.push({msg, fields}),
    child: () => capturingLogger,
}

function context(): FetchContext {
    return {
        http: createHttpClient({type: 'composer', recorder: record => records.push(record)}),
        log: capturingLogger,
        options: {mavenPerVersionLicenses: false},
    }
}

function feed() {
    if (composerRegistry.feed.mode !== 'feed') throw new Error('composer should be a feed-mode registry')
    return composerRegistry.feed
}

/** The two metadata files of a package that has both tagged releases and branches. */
function metadata(url: string): Response {
    if (url === MAIN_URL) return json(monolog)
    if (url === DEV_URL) return json(monologDev)
    return json({error: 'unexpected url ' + url}, 500)
}

beforeEach(() => {
    calls = []
    records = []
    warnings = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('composer fetchPackage', () => {
    it('reads the p2 metadata of the releases and of the branches', async () => {
        stubFetch(metadata)
        const result = await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        expect(calls.map(c => c.url)).toEqual([MAIN_URL, DEV_URL])
        expect(result).not.toBeNull()
        // Oldest first, branches after the tagged releases.
        expect(result!.versions.map(v => v.version)).toEqual([
            '1.0.0-RC1',
            '2.0.0',
            '3.11.0',
            '3.12.0',
            '2.x-dev',
            'dev-main',
        ])
        expect(result!.sources).toEqual(['repo.packagist.org'])
    })

    it('expands the minified metadata, carrying keys forward and honouring __unset', async () => {
        stubFetch(metadata)
        const result = await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        // 3.11.0 lists no license of its own; it inherits 3.12.0's.
        expect(byVersion.get('3.11.0')!.licenses).toEqual(['MIT'])
        expect(byVersion.get('3.12.0')!.licenses).toEqual(['MIT'])
        expect(byVersion.get('2.0.0')!.licenses).toEqual(['MIT', 'LGPL-2.1-only'])
        // `"license": "__unset"` removes the inherited value rather than setting it to that string.
        expect(byVersion.get('1.0.0-RC1')!.licenses).toEqual([])
        // Branch metadata is expanded on its own, from the first entry of the ~dev file.
        expect(byVersion.get('2.x-dev')!.licenses).toEqual(['MIT'])
    })

    it('maps times and marks every branch a pre-release', async () => {
        stubFetch(metadata)
        const result = await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('3.12.0')!.releasedAt?.toISOString()).toBe('2026-09-09T08:34:20.000Z')
        expect(byVersion.get('3.12.0')!.prerelease).toBe(false)
        expect(byVersion.get('1.0.0-RC1')!.prerelease).toBe(true)
        expect(byVersion.get('dev-main')!.prerelease).toBe(true)
        expect(byVersion.get('2.x-dev')!.prerelease).toBe(true)
        // Packagist deletes versions rather than yanking them.
        expect(result!.versions.every(v => !v.yanked)).toBe(true)
    })

    it('takes the library facts from the newest tagged release and designates no latest', async () => {
        stubFetch(metadata)
        const result = await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.description).toBe(
            'Sends your logs to files, sockets, inboxes, databases and various web services',
        )
        expect(result!.homepageUrl).toBe('https://github.com/Seldaek/monolog')
        expect(result!.repoUrl).toBe('https://github.com/Seldaek/monolog')
        expect(result!.registryLatest).toBeUndefined()
    })

    it('expands by carrying keys forward, which is why it only runs on minified files', () => {
        const raw = [{version: '2.0.0', license: ['MIT']}, {version: '1.0.0'}]
        expect(expandMinified(raw)).toEqual([
            {version: '2.0.0', license: ['MIT']},
            {version: '1.0.0', license: ['MIT']},
        ])
    })

    it('does not expand a file that never said it was minified', async () => {
        const plain = {packages: {'monolog/monolog': [{version: '2.0.0', license: ['MIT']}, {version: '1.0.0'}]}}
        stubFetch(url => (url === MAIN_URL ? json(plain) : json({}, 404)))
        const result = await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        // Carrying keys forward here would hand 1.0.0 a license it never declared.
        expect(result!.versions.map(v => [v.version, v.licenses])).toEqual([
            ['1.0.0', []],
            ['2.0.0', ['MIT']],
        ])
    })

    it('has no dev versions when there is no ~dev file, which is not a missing package', async () => {
        stubFetch(url => (url === MAIN_URL ? json(monolog) : json({status: 'error'}, 404)))
        const result = await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())

        expect(result).not.toBeNull()
        expect(result!.versions.map(v => v.version)).toEqual(['1.0.0-RC1', '2.0.0', '3.11.0', '3.12.0'])
    })

    it('returns null on 404 and does not go looking for branches', async () => {
        stubFetch(() => json({status: 'error'}, 404))
        expect(await composerRegistry.fetchPackage(parsePurl('pkg:composer/nope/nope'), context())).toBeNull()
        expect(calls).toHaveLength(1)
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({}, 500))
        await expect(
            composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context()),
        ).rejects.toThrow(/500/)
    })

    it('records every request for fetch_log', async () => {
        stubFetch(metadata)
        await composerRegistry.fetchPackage(parsePurl('pkg:composer/monolog/monolog'), context())
        expect(records).toHaveLength(2)
        expect(records[0]).toMatchObject({source: 'repo.packagist.org', status: 200, error: null})
    })
})

/**
 * Captured from Packagist on 2026-10-02 (expanded, trimmed to the fields the mapping reads).
 *  - laravel/framework, the tags published since 2026-08-01: v13, v12, v11, v10 and v9 are all
 *    still patched, and v11.57.0 shipped half an hour after v13.34.0.
 *  - amirami/localizator: every tag is an `-alpha`, and the `0.x-dev` branch was pushed after the
 *    newest one.
 */
describe('composer latest', () => {
    const laravel = fixture('composer-laravel-recent')
    const localizator = fixture('composer-localizator')
    const localizatorDev = fixture('composer-localizator-dev')

    it('is the highest tagged release, not the newest patch of an older major', () => {
        const result = packageFromMetadata('laravel/framework', laravel, null)
        const byVersion = new Map(result.versions.map(v => [v.version, v]))

        expect(byVersion.get('v11.57.0')!.releasedAt!.getTime()).toBeGreaterThan(
            byVersion.get('v13.34.0')!.releasedAt!.getTime(),
        )
        expect(computeLatest('composer', result.versions).latest).toBe('v13.34.0')
    })

    it('is never a branch, even when every tag is a pre-release', () => {
        const result = packageFromMetadata('amirami/localizator', localizator, localizatorDev)

        expect(result.versions.map(v => v.version)).toContain('0.x-dev')
        expect(computeLatest('composer', result.versions)).toEqual({
            latest: 'v0.14.0-alpha',
            latestPrerelease: undefined,
        })
    })
})

describe('composer feed', () => {
    it('asks for the last minute and keeps the timestamp packagist answers with', async () => {
        stubFetch(() => json(changes))

        const cursor = await feed().initialCursor(context())

        expect(cursor).toBe('17895544800011')
        const since = Number(/since=(\d+)$/.exec(calls[0]!.url)?.[1])
        // The cursor unit is unix seconds x 10 000, and the head is a minute back.
        const expected = (Math.floor(Date.now() / 1000) - 60) * 10_000
        expect(since).toBeGreaterThan(expected - 100_000)
        expect(since).toBeLessThanOrEqual(expected + 100_000)
    })

    it('strips ~dev, drops what is not a package name and advances to the reported timestamp', async () => {
        stubFetch(() => json(changes))

        const result = await feed().poll('17895544220000', context())

        expect(calls[0]?.url).toBe('https://packagist.org/metadata/changes.json?since=17895544220000')
        expect(result.events).toEqual([
            {packageKey: 'pkg:composer/atk4/audit', at: new Date(1789554422 * 1000)},
            // The package and its branches are one package: one event, the newer time.
            {packageKey: 'pkg:composer/monolog/monolog', at: new Date(1789554440 * 1000)},
            {packageKey: 'pkg:composer/raxon/boot', at: new Date(1789554432 * 1000)},
        ])
        expect(result.cursor).toBe('17895544800011')
        expect(result.cursorTime).toEqual(new Date(1789554450 * 1000))
        expect(result.headTime).toEqual(new Date(1789554480 * 1000))
    })

    it('refuses to crawl packagist when it asks for a resync', async () => {
        stubFetch(() => json(changesResync))

        const result = await feed().poll('17895544220000', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('17895544800011')
        expect(warnings.map(w => w.msg)).toContain('packagist asked for a full resync; skipping this batch')
    })

    it('restarts from the head when the cursor is older than the window packagist keeps', async () => {
        stubFetch(() => json({error: 'Invalid or missing "since" query parameter', timestamp: 17895544800011}, 400))

        const result = await feed().poll('1', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('17895544800011')
        expect(result.cursorTime).toBeNull()
        expect(warnings.map(w => w.msg)).toContain('packagist rejected the feed cursor, restarting from its head')
    })

    it('throws when packagist is down', async () => {
        stubFetch(() => json({}, 503))
        await expect(feed().poll('17895544220000', context())).rejects.toThrow(/503/)
    })
})
