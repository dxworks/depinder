import {createRegistryFallback} from '../src/fallback/registry-fallback'
import {resolveRegistryLimits} from '../src/fallback/registry-limits'
import {resetResolverClient, resolvePurls} from '../src/resolver/client'
import {RESOLVER_CHUNK_CONCURRENCY, ResolverConfig} from '../src/resolver/config'
import {profileLines, resetProfile} from '../src/utils/profile'

/**
 * `--profile` counts requests per host. The clients all go through global `fetch`, so the counts
 * are pinned against a stubbed `fetch`: every request the stub sees shows up under its host.
 */

const resolver: ResolverConfig = {
    url: 'https://resolver.example', token: 'secret', maxWaitMs: 60_000,
    chunkConcurrency: RESOLVER_CHUNK_CONCURRENCY,
}

const quiet = {info: vi.fn(), warn: vi.fn()}

/** The resolver answers for nothing; every registry says it has no such package. */
function stubNetwork(): Map<string, number> {
    const seen = new Map<string, number>()
    vi.stubGlobal('fetch', async (input: string | URL) => {
        const url = new URL(String(input))
        seen.set(url.host, (seen.get(url.host) ?? 0) + 1)
        return url.host === 'resolver.example'
            ? new Response(JSON.stringify({done: true, feeds: {}}) + '\n', {status: 200})
            : new Response('', {status: 404})
    })
    return seen
}

/** The `http:<host>` counters from the profile summary. */
function requestCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const line of profileLines()) {
        const match = /^\s*(\d+)\s+http:(\S+)$/.exec(line)
        if (match) counts.set(match[2], Number(match[1]))
    }
    return counts
}

beforeEach(() => {
    resetProfile()
    resetResolverClient()
})

afterEach(() => vi.unstubAllGlobals())

describe('the profile\'s requests per host', () => {
    it('counts the resolver and the registry fallback, one per request', async () => {
        const seen = stubNetwork()

        await resolvePurls(resolver, ['pkg:npm/left-pad@1.3.0'], quiet)
        const fallback = createRegistryFallback(resolveRegistryLimits({}))
        await expect(fallback.lookup({type: 'npm', name: 'left-pad'})).rejects.toThrow('not in the npm registry')
        await expect(fallback.lookup({type: 'pypi', name: 'requests'})).rejects.toThrow('not in the pypi registry')

        expect(seen.get('resolver.example')).toBe(1)
        expect(seen.size).toBeGreaterThanOrEqual(3)
        expect(requestCounts()).toEqual(seen)
    })
})
