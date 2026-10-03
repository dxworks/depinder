import {describe, expect, it} from 'vitest'
import {checkGrype, checkTrivy, normalizeRepository, parseRepository, UpstreamError} from '../../src/vuln/upstream.js'

/**
 * The publishers' metadata, served by a fake `fetch`. The bodies are trimmed from what
 * mirror.gcr.io, ghcr.io and grype.anchore.io answered on 2026-10-01.
 */

const LAYER = 'sha256:2cf80facc0947c50c3b1a719456497fd7cc2b83e2bc60b13b8842207bac4abd0'
const MANIFEST = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    artifactType: 'application/vnd.aquasec.trivy.config.v1+json',
    config: {mediaType: 'application/vnd.oci.empty.v1+json', digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2},
    layers: [{mediaType: 'application/vnd.aquasec.trivy.db.layer.v1.tar+gzip', digest: LAYER, size: 125603976}],
    annotations: {'org.opencontainers.image.created': '2026-10-01T19:07:06Z'},
}
const LATEST = {
    status: 'active',
    schemaVersion: 'v6.1.9',
    built: '2026-10-01T06:33:48Z',
    path: 'vulnerability-db_v6.1.9_2026-10-01T00:39:44Z_1790836428.tar.zst',
    checksum: 'sha256:c0d0263192d91df04b242e9a91e34cb289118fb08f1ed56eb0239eb57d7a517f',
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

/** A fetch that answers from `route` and records every call. */
function fakeFetch(route: Route): {fetch: typeof fetch, calls: {url: string, headers: Record<string, string>}[]} {
    const calls: {url: string, headers: Record<string, string>}[] = []
    const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input)
        calls.push({url, headers: {...init.headers as Record<string, string>}})
        return route(url, init)
    }) as typeof fetch
    return {fetch: fn, calls}
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}})

describe('checkTrivy', () => {
    it('reads the layer digest and created from a registry that answers anonymously', async () => {
        const {fetch, calls} = fakeFetch(() => json(MANIFEST))
        expect(await checkTrivy('mirror.gcr.io/aquasec/trivy-db:2', {fetch}))
            .toEqual({id: LAYER, built_at: '2026-10-01T19:07:06Z', exact: false})
        expect(calls).toHaveLength(1)
        expect(calls[0]!.url).toBe('https://mirror.gcr.io/v2/aquasec/trivy-db/manifests/2')
        expect(calls[0]!.headers.accept).toContain('application/vnd.oci.image.manifest.v1+json')
    })

    it('fetches an anonymous token on a 401 Bearer challenge and asks again with it', async () => {
        const {fetch, calls} = fakeFetch((url, init) => {
            if (url.startsWith('https://ghcr.io/token')) return json({token: 'anon-token'})
            const auth = (init.headers as Record<string, string>).authorization
            if (auth !== 'Bearer anon-token') {
                return json({errors: [{code: 'UNAUTHORIZED'}]}, 401, {
                    'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:aquasecurity/trivy-db:pull"',
                })
            }
            return json(MANIFEST)
        })
        expect(await checkTrivy('ghcr.io/aquasecurity/trivy-db:2', {fetch})).toMatchObject({id: LAYER})
        expect(calls.map(c => c.url)).toEqual([
            'https://ghcr.io/v2/aquasecurity/trivy-db/manifests/2',
            'https://ghcr.io/token?service=ghcr.io&scope=repository%3Aaquasecurity%2Ftrivy-db%3Apull',
            'https://ghcr.io/v2/aquasecurity/trivy-db/manifests/2',
        ])
    })

    it('builds the scope itself when the challenge has none', async () => {
        const {fetch, calls} = fakeFetch((url, init) => {
            if (url.startsWith('https://auth.example.com/')) return json({access_token: 't'})
            if ((init.headers as Record<string, string>).authorization) return json(MANIFEST)
            return json({}, 401, {'www-authenticate': 'Bearer realm="https://auth.example.com/token"'})
        })
        await checkTrivy('registry.example.com/team/trivy-db:2', {fetch})
        expect(calls[1]!.url).toBe('https://auth.example.com/token?scope=repository%3Ateam%2Ftrivy-db%3Apull')
    })

    it('has a null built_at when the manifest has no created annotation', async () => {
        const {fetch} = fakeFetch(() => json({...MANIFEST, annotations: undefined}))
        expect(await checkTrivy('mirror.gcr.io/aquasec/trivy-db:2', {fetch})).toEqual({id: LAYER, built_at: null, exact: false})
    })

    it('cannot tell on an HTTP error, a missing layer, credentials it does not have, or garbage', async () => {
        const cases: [Route, RegExp][] = [
            [() => json({errors: []}, 404), /HTTP 404 from https:\/\/mirror\.gcr\.io\/v2\/aquasec\/trivy-db\/manifests\/2/],
            [() => json({...MANIFEST, layers: [{mediaType: 'application/x-other', digest: 'sha256:1'}]}), /no trivy-db layer/],
            [() => json({}, 401, {'www-authenticate': 'Basic realm="x"'}), /only anonymous pulls/],
            [() => json({}, 401), /only anonymous pulls/],
            [() => new Response('<html>', {status: 200}), /did not answer JSON/],
            [() => {
                throw new TypeError('fetch failed', {cause: new Error('getaddrinfo ENOTFOUND mirror.gcr.io')})
            }, /fetch failed: getaddrinfo ENOTFOUND/],
        ]
        for (const [route, message] of cases) {
            const {fetch} = fakeFetch(route)
            const check = checkTrivy('mirror.gcr.io/aquasec/trivy-db:2', {fetch})
            await expect(check).rejects.toThrow(UpstreamError)
            await expect(check).rejects.toThrow(message)
        }
    })

    it('gives up at its deadline', async () => {
        const {fetch} = fakeFetch((_url, init) => new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        }))
        await expect(checkTrivy('mirror.gcr.io/aquasec/trivy-db:2', {fetch, timeoutMs: 50})).rejects.toThrow('timed out after 50 ms')
    })
})

describe('checkGrype', () => {
    it('reads checksum and built from latest.json, and built is exact', async () => {
        const {fetch, calls} = fakeFetch(() => json(LATEST))
        expect(await checkGrype('https://grype.anchore.io/databases/v6/latest.json', {fetch})).toEqual({
            id: LATEST.checksum,
            built_at: '2026-10-01T06:33:48Z',
            exact: true,
        })
        expect(calls[0]!.url).toBe('https://grype.anchore.io/databases/v6/latest.json')
    })

    it('cannot tell on an HTTP error or a body without checksum and built', async () => {
        for (const [route, message] of [
            [() => json({}, 503), /HTTP 503/],
            [() => json({...LATEST, checksum: undefined}), /no checksum or built/],
            [() => json({...LATEST, built: 12}), /no checksum or built/],
        ] as [Route, RegExp][]) {
            await expect(checkGrype('https://grype.anchore.io/databases/v6/latest.json', {fetch: fakeFetch(route).fetch})).rejects.toThrow(message)
        }
    })
})

describe('repository references', () => {
    it('reads them the way Docker does', () => {
        expect(parseRepository('mirror.gcr.io/aquasec/trivy-db:2')).toEqual({registry: 'mirror.gcr.io', repository: 'aquasec/trivy-db', reference: '2'})
        expect(parseRepository('ghcr.io/aquasecurity/trivy-db')).toEqual({registry: 'ghcr.io', repository: 'aquasecurity/trivy-db', reference: '2'})
        expect(parseRepository('localhost:5000/trivy-db:3')).toEqual({registry: 'localhost:5000', repository: 'trivy-db', reference: '3'})
        expect(parseRepository('aquasec/trivy-db:2')).toEqual({registry: 'registry-1.docker.io', repository: 'aquasec/trivy-db', reference: '2'})
        expect(parseRepository('docker.io/library/trivy-db@sha256:abc')).toEqual({registry: 'registry-1.docker.io', repository: 'library/trivy-db', reference: 'sha256:abc'})
        for (const bad of ['', 'https://ghcr.io/x', 'a b', 'ghcr.io/x:', 'ghcr.io/X/Y:2']) expect(() => parseRepository(bad), bad).toThrow()
    })

    it('adds the tag Trivy would assume, so check and download read the same thing', () => {
        expect(normalizeRepository('ghcr.io/aquasecurity/trivy-db')).toBe('ghcr.io/aquasecurity/trivy-db:2')
        expect(normalizeRepository('localhost:5000/trivy-db')).toBe('localhost:5000/trivy-db:2')
        expect(normalizeRepository('mirror.gcr.io/aquasec/trivy-db:2')).toBe('mirror.gcr.io/aquasec/trivy-db:2')
        expect(normalizeRepository('ghcr.io/x/trivy-db@sha256:abc')).toBe('ghcr.io/x/trivy-db@sha256:abc')
    })
})
