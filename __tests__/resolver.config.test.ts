import {DEFAULT_RESOLVER_MAX_WAIT_MS, resolverConfig} from '../src/resolver/config'

/**
 * The resolver is opt-in, and every way of not opting in must end at the same place: `undefined`,
 * meaning "run exactly as depinder ran before". The one case that warns is a configured URL with
 * no token, because that is a mistake rather than a choice — and the server answers nothing at all
 * without a bearer token, so it would otherwise look like a resolver that knows nothing.
 */

const vars = ['DEPINDER_RESOLVER_URL', 'DEPINDER_RESOLVER_TOKEN', 'DEPINDER_RESOLVER_MAX_WAIT_MS'] as const

describe('the resolver configuration', () => {
    const saved: {[key: string]: string | undefined} = {}

    beforeEach(() => {
        for (const key of vars) {
            saved[key] = process.env[key]
            delete process.env[key]
        }
    })
    afterEach(() => {
        for (const key of vars) {
            if (saved[key] === undefined) delete process.env[key]
            else process.env[key] = saved[key]
        }
    })

    it('is off when nothing is configured', () => {
        expect(resolverConfig({})).toBeUndefined()
        expect(resolverConfig()).toBeUndefined()
    })

    it('reads the url and token from the environment', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://resolver.example'
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'

        expect(resolverConfig({})).toEqual({
            url: 'https://resolver.example',
            token: 'secret',
            maxWaitMs: DEFAULT_RESOLVER_MAX_WAIT_MS,
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

    it('is off, and says so, when the url has no token with it', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://resolver.example'
        expect(resolverConfig({})).toBeUndefined()
    })

    it('is off when --no-resolver is given, whatever the environment says', () => {
        process.env.DEPINDER_RESOLVER_URL = 'https://resolver.example'
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'

        expect(resolverConfig({resolver: false})).toBeUndefined()
        expect(resolverConfig({resolver: false, resolverUrl: 'https://resolver.example'})).toBeUndefined()
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

    it('ignores an empty or whitespace url', () => {
        process.env.DEPINDER_RESOLVER_TOKEN = 'secret'
        expect(resolverConfig({resolverUrl: '   '})).toBeUndefined()
        process.env.DEPINDER_RESOLVER_URL = ''
        expect(resolverConfig({})).toBeUndefined()
    })
})
