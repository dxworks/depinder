import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {fetchLibraryInfo} from '../src/fallback/fetch-library-info'
import {createRegistryClients} from '../src/fallback/registry-clients'

/**
 * The CLI's fallback road: core's fetch and conversion, then the resolver adapter. A stubbed
 * `fetch` stands in for the registry, so these run without a network.
 */

const OPEN = {concurrency: 8, minIntervalMs: 0}
const FETCHED_AT = new Date('2026-10-03T12:00:00Z')

let requested: string[]

function stubRegistry(answer: (url: string, attempt: number) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL) => {
        const url = String(input)
        requested.push(url)
        return Promise.resolve(answer(url, requested.filter(it => it === url).length))
    })
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}})
}

const packument = {
    name: '@acme/left-pad',
    description: 'pads on the left',
    homepage: 'https://acme.example/left-pad',
    repository: {type: 'git', url: 'git+https://github.com/acme/left-pad.git'},
    license: 'MIT',
    'dist-tags': {latest: '1.1.0'},
    versions: {'1.0.0': {}, '1.1.0': {}, '2.0.0-beta.1': {}},
    time: {
        '1.0.0': '2024-01-01T00:00:00.000Z',
        '1.1.0': '2024-06-01T00:00:00.000Z',
        '2.0.0-beta.1': '2025-01-01T00:00:00.000Z',
    },
}

const deps = () => ({clients: createRegistryClients({limits: {byType: {}, fallback: OPEN}}), now: () => FETCHED_AT})

beforeEach(() => {
    requested = []
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('fetchLibraryInfo', () => {
    it('turns a registry answer into the LibraryInfo the resolver adapter gives', async () => {
        stubRegistry(() => json(packument))

        const result = await fetchLibraryInfo({type: 'npm', name: '@acme/left-pad'}, deps())

        expect(requested).toEqual(['https://registry.npmjs.org/@acme%2Fleft-pad'])
        expect(result).toEqual({
            status: 'found',
            info: {
                name: '@acme/left-pad',
                description: 'pads on the left',
                versions: [
                    {version: '1.0.0', timestamp: Date.parse('2024-01-01T00:00:00Z'), latest: false, licenses: ['MIT']},
                    {version: '1.1.0', timestamp: Date.parse('2024-06-01T00:00:00Z'), latest: true, licenses: ['MIT']},
                    {version: '2.0.0-beta.1', timestamp: Date.parse('2025-01-01T00:00:00Z'), latest: false, licenses: ['MIT']},
                ],
                licenses: ['MIT'],
                homepageUrl: 'https://acme.example/left-pad',
                reposUrl: ['https://github.com/acme/left-pad'],
                issuesUrl: [],
                keywords: [],
            },
        })
    })

    it('says not_found when the registry has no such package', async () => {
        stubRegistry(() => json({error: 'Not found'}, 404))

        expect(await fetchLibraryInfo({type: 'npm', name: 'no-such-package'}, deps())).toEqual({status: 'not_found'})
    })

    it('says error, not not_found, when the registry fails', async () => {
        stubRegistry(() => json({error: 'boom'}, 503))

        const result = await fetchLibraryInfo({type: 'npm', name: 'left-pad'}, deps())

        expect(result.status).toBe('error')
        expect(String((result as {error: unknown}).error)).toContain('503')
    })

    it('says error for a name its registry cannot have, without asking it', async () => {
        stubRegistry(() => json(packument))

        const result = await fetchLibraryInfo({type: 'maven', name: 'no-group-id'}, deps())

        expect(result.status).toBe('error')
        expect(requested).toEqual([])
    })

    it('says error for a purl type core has no registry for', async () => {
        const result = await fetchLibraryInfo({type: 'conda', name: 'numpy'}, deps())

        expect(result.status).toBe('error')
    })

    it('waits out one 429 and asks again', async () => {
        stubRegistry((_url, attempt) => attempt === 1 ? json({}, 429, {'retry-after': '0'}) : json(packument))

        const result = await fetchLibraryInfo({type: 'npm', name: '@acme/left-pad'}, deps())

        expect(result.status).toBe('found')
        expect(requested).toHaveLength(2)
    })
})
