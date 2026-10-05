import type {MockInstance} from 'vitest'
import {
    DEFAULT_RESOLVER_MAX_WAIT_MS, DEFAULT_RESOLVER_URL, RESOLVER_CHUNK_CONCURRENCY, resolverConfig,
} from '../src/resolver/config'
import {log} from '../src/utils/logging'

/**
 * The resolver is on by default, at libs.dxworks.org. `undefined` means "registry fallback only":
 * `--no-resolver`, or no token, in which case it warns once and says how to fix it.
 */

const vars = [
    'DEPINDER_RESOLVER_URL',
    'DEPINDER_RESOLVER_TOKEN',
    'DEPINDER_RESOLVER_MAX_WAIT_MS',
    'DEPINDER_RESOLVER_CONCURRENCY',
] as const

describe('the resolver configuration', () => {
    const saved: {[key: string]: string | undefined} = {}
    let warnings: string[]
    let warnSpy: MockInstance

    beforeEach(() => {
        for (const key of vars) {
            saved[key] = process.env[key]
            delete process.env[key]
        }
        warnings = []
        warnSpy = vi.spyOn(log, 'warn').mockImplementation(((message: string) => {
            warnings.push(message)
            return log
        }) as any)
    })
    afterEach(() => {
        for (const key of vars) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
        warnSpy.mockRestore()
    })

    it('uses libs.dxworks.org when no url is configured', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        expect(DEFAULT_RESOLVER_URL).toBe('https://libs.dxworks.org')
        expect(resolverConfig({})?.url).toBe(DEFAULT_RESOLVER_URL)
        expect(resolverConfig()?.url).toBe(DEFAULT_RESOLVER_URL)
    })

    it('is off, with one warning on how to fix it, when no token is set', () => {
        expect(resolverConfig({})).toBeUndefined()
        expect(warnings).toEqual([
            'Resolver at https://libs.dxworks.org skipped: set DEPINDER_RESOLVER_TOKEN to use it, or pass --no-resolver',
        ])
    })

    it('takes the environment url over the default', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://resolver.example'
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'

        expect(resolverConfig({})).toEqual({
            url: 'https://resolver.example',
            token: 'secret',
            maxWaitMs: DEFAULT_RESOLVER_MAX_WAIT_MS,
            chunkConcurrency: RESOLVER_CHUNK_CONCURRENCY,
        })
    })

    it('lets --resolver-url override the environment', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://from-env.example'
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'

        expect(resolverConfig({resolverUrl: 'https://from-flag.example'})?.url).toBe('https://from-flag.example')
    })

    it('drops a trailing slash, so the client can append /resolve', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        expect(resolverConfig({resolverUrl: 'https://resolver.example/'})?.url).toBe('https://resolver.example')
    })

    it('names the configured url in the missing-token warning', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://resolver.example'
        expect(resolverConfig({})).toBeUndefined()
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toMatch(/^Resolver at https:\/\/resolver\.example skipped: /)
    })

    it('is off when --no-resolver is given, whatever the environment says', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://resolver.example'
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'

        expect(resolverConfig({resolver: false})).toBeUndefined()
        expect(resolverConfig({resolver: false, resolverUrl: 'https://resolver.example'})).toBeUndefined()
    })

    it('is off without a warning when --no-resolver is given and no token is set', () => {
        expect(resolverConfig({resolver: false})).toBeUndefined()
        expect(warnings).toEqual([])
    })

    it('is on when commander leaves resolver at its default true', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        expect(resolverConfig({resolver: true, resolverUrl: 'https://resolver.example'})).toBeDefined()
    })

    it('takes the wait budget from the environment, and ignores nonsense', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        const options = {resolverUrl: 'https://resolver.example'}

        process.env.DEPINDER_RESOLVER_MAX_WAIT_MS = '5000'
        expect(resolverConfig(options)?.maxWaitMs).toBe(5000)

        process.env.DEPINDER_RESOLVER_MAX_WAIT_MS = 'soon'
        expect(resolverConfig(options)?.maxWaitMs).toBe(DEFAULT_RESOLVER_MAX_WAIT_MS)

        process.env.DEPINDER_RESOLVER_MAX_WAIT_MS = '-1'
        expect(resolverConfig(options)?.maxWaitMs).toBe(DEFAULT_RESOLVER_MAX_WAIT_MS)
    })

    it('posts every chunk at once unless the environment caps it, and ignores nonsense', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        const options = {resolverUrl: 'https://resolver.example'}

        expect(RESOLVER_CHUNK_CONCURRENCY).toBe(Infinity)
        delete process.env.DEPINDER_RESOLVER_CONCURRENCY
        expect(resolverConfig(options)?.chunkConcurrency).toBe(Infinity)

        process.env.DEPINDER_RESOLVER_CONCURRENCY = '8'
        expect(resolverConfig(options)?.chunkConcurrency).toBe(8)

        // Half a chunk in flight is not a thing, and neither is none: both fall back rather than
        // leaving the bulk phase asking nothing at all.
        for (const nonsense of ['four', '0', '-2', '2.5', '']) {
            process.env.DEPINDER_RESOLVER_CONCURRENCY = nonsense
            expect(resolverConfig(options)?.chunkConcurrency).toBe(RESOLVER_CHUNK_CONCURRENCY)
        }
    })

    it('treats a blank flag or environment url as unset, and falls through to the next source', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        process.env.DEPINDER_RESOLVER_URL = 'https://from-env.example'
        expect(resolverConfig({resolverUrl: '   '})?.url).toBe('https://from-env.example')

        process.env.DEPINDER_RESOLVER_URL = '  '
        expect(resolverConfig({})?.url).toBe(DEFAULT_RESOLVER_URL)
        expect(resolverConfig({resolverUrl: ''})?.url).toBe(DEFAULT_RESOLVER_URL)
    })
})
