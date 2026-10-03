import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHttpClient, resetLimiters, type FetchRecord} from '../../../src/resolver/registries/http.js'
import {type Logger, parsePurl} from '@depinder/core'
import {gemRegistry, parseCompactIndex} from '../../../src/resolver/registries/gem.js'
import type {FetchContext} from '../../../src/resolver/registries/types.js'

const read = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8')
const fixture = (name: string): unknown => JSON.parse(read(`${name}.json`))

const versionsDoc = fixture('gem-versions') as Record<string, unknown>[]
const gemDoc = fixture('gem-gem') as Record<string, unknown>
const compactIndex = read('gem-compact-index.txt')

const VERSIONS_URL = 'https://rubygems.org/api/v1/versions/rack-proxy.json'
const GEM_URL = 'https://rubygems.org/api/v1/gems/rack-proxy.json'
const INDEX_URL = 'https://rubygems.org/versions'

interface Call {
    url: string
    method: string
    headers: Record<string, string>
}

let calls: Call[]
let records: FetchRecord[]
let warnings: {msg: string; fields?: Record<string, unknown>}[]

function stubFetch(handler: (url: string, init: RequestInit) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({
            url,
            method: String(init.method ?? 'GET'),
            headers: (init.headers ?? {}) as Record<string, string>,
        })
        return Promise.resolve(handler(url, init))
    })
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, {status, headers: {'content-type': 'text/plain', ...headers}})
}

/** The happy-path two-request answer: version list, then gem document. */
function rubygems(url: string): Response {
    if (url === VERSIONS_URL) return json(versionsDoc)
    if (url === GEM_URL) return json(gemDoc)
    throw new Error(`unexpected url ${url}`)
}

const recordingLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (msg, fields) => warnings.push({msg, fields}),
    error: () => undefined,
    child: () => recordingLogger,
}

function context(): FetchContext {
    return {
        http: createHttpClient({type: 'gem', recorder: record => records.push(record)}),
        log: recordingLogger,
        options: {mavenPerVersionLicenses: false},
    }
}

function feed() {
    if (gemRegistry.feed.mode !== 'feed') throw new Error('gem should be a feed-mode registry')
    return gemRegistry.feed
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

describe('gem fetchPackage', () => {
    it('reads both documents and normalises them', async () => {
        stubFetch(rubygems)
        const result = await gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())

        expect(calls.map(c => c.url)).toEqual([VERSIONS_URL, GEM_URL])
        expect(result).not.toBeNull()
        expect(result!.description).toBe('A request/response rewriting HTTP proxy. A Rack app.')
        expect(result!.homepageUrl).toBe('https://github.com/ncr/rack-proxy')
        // `source_code_uri` is null at the top level, so the one under `metadata` is used, and
        // `git+…/rack-proxy.git` is normalised to a browsable URL.
        expect(result!.repoUrl).toBe('https://github.com/ncr/rack-proxy')
        expect(result!.licenses).toEqual(['MIT'])
        expect(result!.registryLatest).toBe('1.4.0')
        expect(result!.sources).toEqual(['rubygems.org'])
    })

    it('maps versions, dates, licenses and the registry pre-release flag', async () => {
        stubFetch(rubygems)
        const result = await gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('1.4.0')!.releasedAt?.toISOString()).toBe('2024-03-04T09:11:00.000Z')
        expect(byVersion.get('1.3.0')!.licenses).toEqual(['MIT', 'Apache-2.0'])
        // `licenses: null` is how rubygems spells "the gemspec declared none".
        expect(byVersion.get('1.2.0')!.licenses).toEqual([])
        // `2.0.0.beta1` is not semver; rubygems' own flag is what catches it.
        expect(byVersion.get('2.0.0.beta1')!.prerelease).toBe(true)
        expect(byVersion.get('1.4.0')!.prerelease).toBe(false)
        // A yanked version is absent from versions.json; there is nothing here to mark.
        expect(result!.versions.every(v => v.yanked === false)).toBe(true)
    })

    it('emits each version number once, preferring the ruby platform build', async () => {
        stubFetch(rubygems)
        const result = await gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())

        expect(result!.versions.map(v => v.version)).toEqual(['2.0.0.beta1', '1.4.0', '1.3.0', '1.2.0'])
        // 1.4.0 ships for ruby, x86_64-linux and java: the ruby build's timestamp wins.
        expect(result!.versions.filter(v => v.version === '1.4.0')).toHaveLength(1)
        // 1.3.0 has no ruby build at all, so the first platform entry stands in for it.
        const v13 = result!.versions.find(v => v.version === '1.3.0')!
        expect(v13.releasedAt?.toISOString()).toBe('2023-11-20T08:00:00.000Z')
    })

    it('falls back to the current version licenses when the gem declares none', async () => {
        stubFetch(url => (url === VERSIONS_URL ? json(versionsDoc) : json({...gemDoc, licenses: null})))
        const result = await gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())
        expect(result!.licenses).toEqual(['MIT'])
    })

    it('continues without the gem document when only that one 404s', async () => {
        stubFetch(url => (url === VERSIONS_URL ? json(versionsDoc) : json({error: 'not found'}, 404)))
        const result = await gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())

        expect(result).not.toBeNull()
        expect(result!.versions).toHaveLength(4)
        expect(result!.registryLatest).toBeUndefined()
        expect(result!.licenses).toEqual([])
    })

    it('returns null when the gem does not exist', async () => {
        stubFetch(() => json({error: 'This rubygem could not be found.'}, 404))
        expect(await gemRegistry.fetchPackage(parsePurl('pkg:gem/no-such-gem-xyzzy'), context())).toBeNull()
        expect(calls).toHaveLength(1) // no point asking for the gem document
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({error: 'boom'}, 500))
        await expect(gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())).rejects.toThrow(/500/)
    })

    it('records every request for fetch_log', async () => {
        stubFetch(rubygems)
        await gemRegistry.fetchPackage(parsePurl('pkg:gem/rack-proxy'), context())
        expect(records).toHaveLength(2)
        expect(records[0]).toMatchObject({source: 'rubygems.org', status: 200, error: null})
    })
})

describe('gem compact index parsing', () => {
    it('reads whole lines only and leaves a partial trailing line for the next poll', () => {
        const {consumedBytes, names} = parseCompactIndex(compactIndex)
        expect(names).toEqual(['rack-proxy', 'devise_masquerade', 'spec_ai'])
        expect(consumedBytes).toBe(Buffer.byteLength(compactIndex.slice(0, compactIndex.lastIndexOf('\n') + 1)))
        expect(consumedBytes).toBeLessThan(Buffer.byteLength(compactIndex))
    })

    it('consumes nothing when the slice has no line ending yet', () => {
        expect(parseCompactIndex('half-written-gem 0.0')).toEqual({consumedBytes: 0, names: []})
    })

    it('skips the compact index header', () => {
        const {names} = parseCompactIndex('created_at: 2026-09-01T00:00:04Z\n---\nrack 3.1.0 abc\n')
        expect(names).toEqual(['rack'])
    })
})

const WHOLE_LINES = Buffer.byteLength(compactIndex.slice(0, compactIndex.lastIndexOf('\n') + 1))

/** HEAD reports `size`; the ranged GET is whatever the test wants. */
function compactIndexOfSize(size: number, ranged: () => Response): (url: string, init: RequestInit) => Response {
    return (_url, init) => (String(init.method) === 'HEAD' ? text('', 200, {'content-length': String(size)}) : ranged())
}

describe('gem feed', () => {
    it('starts from the size of the compact index', async () => {
        stubFetch(() => text('', 200, {'content-length': '23388275'}))
        const cursor = await feed().initialCursor(context())

        expect(cursor).toBe('23388275')
        expect(calls[0]).toMatchObject({url: INDEX_URL, method: 'HEAD'})
    })

    it('falls back to a one-byte range request when HEAD reports no length', async () => {
        stubFetch((_url, init) =>
            String(init.method) === 'HEAD' ? text('', 200) : text('c', 206, {'content-range': 'bytes 0-0/23388275'}),
        )
        expect(await feed().initialCursor(context())).toBe('23388275')
        expect(calls[1]?.headers.range).toBe('bytes=0-0')
    })

    it('asks for the bytes appended since the cursor and advances by whole lines', async () => {
        const total = 1000 + Buffer.byteLength(compactIndex)
        stubFetch(compactIndexOfSize(total, () => text(compactIndex, 206)))
        const result = await feed().poll('1000', context())

        // A closed range: the open-ended form is what makes Fastly answer 200 with the whole file.
        expect(calls[1]?.headers.range).toBe(`bytes=1000-${total - 1}`)
        expect(result.events.map(e => e.packageKey)).toEqual([
            'pkg:gem/rack-proxy',
            'pkg:gem/devise_masquerade',
            'pkg:gem/spec_ai',
        ])
        expect(result.events.every(e => e.at === null)).toBe(true)
        expect(result.cursor).toBe(String(1000 + WHOLE_LINES))
        // Compact index lines carry no timestamp: freshness is "when we last looked".
        expect(result.cursorTime).toBeInstanceOf(Date)
        expect(result.headTime).toBeNull()
    })

    it('makes no range request at all when the cursor is already at the head', async () => {
        stubFetch(() => text('', 200, {'content-length': '23388275'}))
        const result = await feed().poll('23388275', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('23388275')
        expect(result.cursorTime).toBeInstanceOf(Date)
        // The whole point: a quiet tick must not pull 23 MB. Only the HEAD went out.
        expect(calls).toHaveLength(1)
        expect(calls[0]?.method).toBe('HEAD')
    })

    it('still treats a 416 as "nothing new" for caches that send one', async () => {
        stubFetch(compactIndexOfSize(23388275, () => text('', 416, {'content-range': 'bytes */23388275'})))
        const result = await feed().poll('23388000', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe('23388000')
    })

    it('re-anchors when the index is shorter than the cursor', async () => {
        stubFetch(() => text('', 200, {'content-length': '1024'}))
        const result = await feed().poll('23388275', context())

        expect(result.cursor).toBe('1024')
        expect(result.events).toEqual([])
        expect(warnings[0]?.msg).toMatch(/shorter than the cursor/)
    })

    it('re-anchors at the head without events when the range is ignored', async () => {
        stubFetch(compactIndexOfSize(23388275, () => text(compactIndex, 200)))
        const result = await feed().poll('1000', context())

        expect(result.events).toEqual([])
        expect(result.cursor).toBe(String(Buffer.byteLength(compactIndex)))
        expect(warnings[0]?.msg).toMatch(/rebuilt/)
    })

    it('throws when the compact index is unavailable', async () => {
        stubFetch(compactIndexOfSize(5000, () => text('nope', 503)))
        await expect(feed().poll('1', context())).rejects.toThrow(/503/)
    })

    it('throws when the size cannot be determined at all', async () => {
        stubFetch(() => text('nope', 503))
        await expect(feed().poll('1', context())).rejects.toThrow(/did not report the size/)
    })
})
