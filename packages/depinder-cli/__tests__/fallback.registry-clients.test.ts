import {createRegistryClients} from '../src/fallback/registry-clients'

const OPEN = {concurrency: 8, minIntervalMs: 0}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('the CLI registry clients', () => {
    it('ask once more after a dropped connection', async () => {
        vi.useFakeTimers()
        let calls = 0
        vi.stubGlobal('fetch', () => ++calls === 1
            ? Promise.reject(new TypeError('fetch failed'))
            : Promise.resolve(new Response('{}', {status: 200})))
        const client = createRegistryClients({limits: {byType: {}, fallback: OPEN}}).forType('golang')

        const pending = client.get('https://proxy.golang.org/dario.cat/mergo/@v/list')
        await vi.runAllTimersAsync()

        expect((await pending).status).toBe(200)
        expect(calls).toBe(2)
    })
})
