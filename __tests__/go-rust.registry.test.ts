import fetch from 'node-fetch'
import {escapeModulePath, goChecker, retrieveFromGoProxy} from '../src/plugins/go/registrar'
import {retrieveFromCratesIo, rustChecker} from '../src/plugins/rust/registrar'
import {sbomGo, sbomRust, sbomPluginsForPurlTypes} from '../src/plugins/sbom'
import {ecosystemOf} from '../src/extension-points/plugin'

/**
 * The Go and Rust registrars, against canned responses shaped like the real ones (a
 * `curl` of proxy.golang.org and crates.io, trimmed). Both registries are public and unauthenticated,
 * so what is worth pinning is how their answers are folded into a LibraryInfo, not that they answer.
 */

jest.mock('node-fetch')
const mockedFetch = fetch as unknown as jest.Mock

interface CannedResponse {
    status?: number
    body: string
}

function respondWith(routes: {[urlSuffix: string]: CannedResponse}) {
    mockedFetch.mockImplementation(async (url: string) => {
        const match = Object.keys(routes).find(suffix => url.endsWith(suffix))
        const canned = match ? routes[match] : {status: 404, body: 'not found'}
        const status = canned.status ?? 200
        return {
            ok: status >= 200 && status < 300,
            status,
            text: async () => canned.body,
            json: async () => JSON.parse(canned.body),
        }
    })
}

beforeEach(() => mockedFetch.mockReset())

describe('the Go module proxy registrar', () => {
    it('case-encodes module paths the way the proxy requires', () => {
        expect(escapeModulePath('github.com/Masterminds/semver/v3')).toBe('github.com/!masterminds/semver/v3')
        expect(escapeModulePath('golang.org/x/net')).toBe('golang.org/x/net')
    })

    it('lists the tagged versions, times each one, and marks @latest', async () => {
        respondWith({
            '/@v/list': {body: 'v3.3.0\nv3.4.0\n'},
            '/@latest': {body: JSON.stringify({Version: 'v3.4.0', Time: '2025-06-27T14:48:33Z',
                Origin: {VCS: 'git', URL: 'https://github.com/Masterminds/semver'}})},
            '/@v/v3.3.0.info': {body: JSON.stringify({Version: 'v3.3.0', Time: '2024-08-01T00:00:00Z'})},
            '/@v/v3.4.0.info': {body: JSON.stringify({Version: 'v3.4.0', Time: '2025-06-27T14:48:33Z'})},
        })

        const info = await retrieveFromGoProxy('github.com/Masterminds/semver/v3')

        expect(info.name).toBe('github.com/Masterminds/semver/v3')
        expect(info.versions).toEqual([
            {version: 'v3.3.0', timestamp: Date.parse('2024-08-01T00:00:00Z'), latest: false, licenses: []},
            {version: 'v3.4.0', timestamp: Date.parse('2025-06-27T14:48:33Z'), latest: true, licenses: []},
        ])
        // The proxy carries no licence data; empty is the honest answer, not a guess.
        expect(info.licenses).toEqual([])
        expect(info.homepageUrl).toBe('https://github.com/Masterminds/semver')
        expect(mockedFetch.mock.calls[0][0]).toBe('https://proxy.golang.org/github.com/!masterminds/semver/v3/@v/list')
    })

    it('keeps the pseudo-version @latest of an untagged module', async () => {
        respondWith({
            '/@v/list': {body: ''},
            '/@latest': {body: JSON.stringify({Version: 'v0.0.0-20210328193216-ff5ff6dc229b', Time: '2021-03-28T19:32:16Z'})},
            '/@v/v0.0.0-20210328193216-ff5ff6dc229b.info': {body: JSON.stringify({Version: 'v0.0.0-20210328193216-ff5ff6dc229b', Time: '2021-03-28T19:32:16Z'})},
        })

        const info = await retrieveFromGoProxy('github.com/aryann/difflib')

        expect(info.versions.map(it => it.version)).toEqual(['v0.0.0-20210328193216-ff5ff6dc229b'])
        expect(info.versions[0].latest).toBe(true)
        expect(info.homepageUrl).toBe('https://pkg.go.dev/github.com/aryann/difflib')
    })

    it('fails loudly for a module the proxy does not know, so the cache never stores a blank', async () => {
        respondWith({})
        await expect(retrieveFromGoProxy('github.com/nobody/nothing')).rejects.toThrow('404')
    })

    it('asks GitHub for GO advisories with a golang purl', () => {
        expect(goChecker.githubSecurityAdvisoryEcosystem).toBe('GO')
        expect(goChecker.getPURL?.('golang.org/x/net', 'v0.57.0')).toBe('pkg:golang/golang.org/x/net@v0.57.0')
    })
})

describe('the crates.io registrar', () => {
    const crate = {
        crate: {
            name: 'aho-corasick', description: 'Fast multiple substring searching.',
            homepage: 'https://github.com/BurntSushi/aho-corasick',
            repository: 'https://github.com/BurntSushi/aho-corasick',
            max_stable_version: '1.1.4', newest_version: '1.1.4', downloads: 1110500999,
        },
        versions: [
            {num: '1.1.4', created_at: '2026-08-03T11:44:11Z', license: 'Unlicense OR MIT', yanked: false, downloads: 29566708},
            {num: '1.1.3', created_at: '2024-03-20T00:00:00Z', license: 'Unlicense OR MIT', yanked: true, downloads: 5},
            {num: '1.1.2', created_at: '2023-10-09T00:00:00Z', license: 'Unlicense OR MIT', yanked: false, downloads: 100},
        ],
    }

    it('folds one response into versions, licence and links, dropping yanked versions', async () => {
        respondWith({'/crates/aho-corasick': {body: JSON.stringify(crate)}})

        const info = await retrieveFromCratesIo('aho-corasick')

        expect(info.versions.map(it => [it.version, it.latest])).toEqual([['1.1.4', true], ['1.1.2', false]])
        expect(info.versions[1].timestamp).toBe(Date.parse('2023-10-09T00:00:00Z'))
        expect(info.versions[0].licenses).toEqual(['Unlicense OR MIT'])
        expect(info.licenses).toEqual(['Unlicense OR MIT'])
        expect(info.homepageUrl).toBe('https://github.com/BurntSushi/aho-corasick')
    })

    it('identifies itself, which crates.io requires of every client', async () => {
        respondWith({'/crates/aho-corasick': {body: JSON.stringify(crate)}})
        await retrieveFromCratesIo('aho-corasick')
        expect(mockedFetch.mock.calls[0][1].headers['User-Agent']).toMatch(/depinder/)
    })

    it('fails loudly for an unknown crate', async () => {
        respondWith({})
        await expect(retrieveFromCratesIo('no-such-crate')).rejects.toThrow('404')
    })

    it('asks GitHub for RUST advisories with a cargo purl', () => {
        expect(rustChecker.githubSecurityAdvisoryEcosystem).toBe('RUST')
        expect(rustChecker.getPURL?.('regex', '1.10.0')).toBe('pkg:cargo/regex@1.10.0')
    })
})

describe('the sbom-go and sbom-rust plugins', () => {
    it('are selected by the golang and cargo purl types', () => {
        expect(sbomPluginsForPurlTypes(['golang', 'cargo']).map(it => it.name)).toEqual(['sbom-go', 'sbom-rust'])
    })

    it('cache under their own ecosystem names, not under the plugin name', () => {
        expect(ecosystemOf(sbomGo)).toBe('go')
        expect(ecosystemOf(sbomRust)).toBe('rust')
    })
})
