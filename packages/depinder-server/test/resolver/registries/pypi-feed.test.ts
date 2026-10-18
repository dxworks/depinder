import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {resetLimiters} from '../../../src/resolver/registries/http.js'
import {pypiFeed} from '../../../src/resolver/registries/pypi-feed.js'
import {decodeMethodResponse, encodeMethodCall} from '../../../src/resolver/registries/pypi-xmlrpc.js'
import {feedContext, feedFixture, feedMode} from './feed.helpers.js'

const changelog = feedFixture('pypi-changelog.xml')
const feed = feedMode(pypiFeed)

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]

function stubFetch(handler: (url: string) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({url, init})
        return Promise.resolve(handler(url))
    })
}

function xml(body: string, status = 200): Response {
    return new Response(body, {status, headers: {'content-type': 'text/xml; charset=UTF-8'}})
}

const context = () => feedContext('pypi')

beforeEach(() => {
    calls = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('pypi feed', () => {
    it('starts from the current changelog serial', async () => {
        stubFetch(() => xml('<?xml version="1.0"?><methodResponse><params><param><value><int>41125269</int></value></param></params></methodResponse>'))

        const cursor = await feed.initialCursor(context())

        expect(cursor).toBe('41125269')
        expect(calls[0]?.url).toBe('https://pypi.org/pypi')
        expect(calls[0]?.init?.method).toBe('POST')
        expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('text/xml')
        expect(String(calls[0]?.init?.body)).toContain('<methodName>changelog_last_serial</methodName>')
    })

    it('collapses the rows of one upload into one event per package and keeps the biggest serial', async () => {
        stubFetch(() => xml(changelog))

        const result = await feed.poll('41125229', context())

        expect(String(calls[0]?.init?.body)).toContain(
            '<methodName>changelog_since_serial</methodName><params><param><value><int>41125229</int></value></param></params>',
        )
        expect(result.events).toEqual([
            {packageKey: 'pkg:pypi/sqlleaf', at: new Date(1789554294 * 1000)},
            // PEP 503 normalised, so the key matches the one in the database.
            {packageKey: 'pkg:pypi/trig-guard', at: new Date(1789554300 * 1000)},
            // `remove project` carries a nil version and still means "this package changed".
            {packageKey: 'pkg:pypi/cmdbsyncer', at: new Date(1789554305 * 1000)},
        ])
        expect(result.cursor).toBe('41125237')
        expect(result.cursorTime).toEqual(new Date(1789554305 * 1000))
        expect(result.headTime).toBeNull()
    })

    it('keeps the cursor where it was when nothing changed', async () => {
        stubFetch(() =>
            xml('<?xml version="1.0"?><methodResponse><params><param><value><array><data></data></array></value></param></params></methodResponse>'),
        )
        const result = await feed.poll('41125237', context())
        expect(result.events).toEqual([])
        expect(result.cursor).toBe('41125237')
        expect(result.cursorTime).toBeNull()
    })

    it('throws when the changelog is unavailable', async () => {
        stubFetch(() => xml('<html>503</html>', 503))
        await expect(feed.poll('1', context())).rejects.toThrow(/503/)
    })

    it('refuses a cursor that is not an integer', async () => {
        stubFetch(() => xml(changelog))
        await expect(feed.poll('not-a-serial', context())).rejects.toThrow(/not an integer/)
    })
})

describe('xml-rpc', () => {
    it('encodes a call with an integer parameter', () => {
        expect(encodeMethodCall('changelog_since_serial', [41125229])).toBe(
            '<?xml version="1.0"?><methodCall><methodName>changelog_since_serial</methodName>' +
                '<params><param><value><int>41125229</int></value></param></params></methodCall>',
        )
    })

    it('encodes a call with no parameters', () => {
        expect(encodeMethodCall('changelog_last_serial', [])).toBe(
            '<?xml version="1.0"?><methodCall><methodName>changelog_last_serial</methodName>' +
                '<params></params></methodCall>',
        )
    })

    it('decodes ints, strings, nil and nested arrays', () => {
        const decoded = decodeMethodResponse(changelog) as unknown as unknown[][]
        expect(decoded).toHaveLength(4)
        expect(decoded[0]).toEqual([
            'sqlleaf',
            '0.0.1',
            1789554292,
            'add py3 file sqlleaf-0.0.1-py3-none-any.whl',
            41125230,
        ])
        expect(decoded[3]![1]).toBeNull()
    })

    it('decodes entities and booleans', () => {
        const body =
            '<?xml version="1.0"?><methodResponse><params><param><value><array><data>' +
            '<value><string>a &amp; b &lt;c&gt; &#65;</string></value>' +
            '<value><boolean>1</boolean></value>' +
            '<value><boolean>0</boolean></value>' +
            '<value>bare string</value>' +
            '</data></array></value></param></params></methodResponse>'
        expect(decodeMethodResponse(body)).toEqual(['a & b <c> A', true, false, 'bare string'])
    })

    it('raises a fault as an error', () => {
        const body =
            "<?xml version='1.0'?><methodResponse><fault><value><struct>" +
            '<member><name>faultCode</name><value><int>1</int></value></member>' +
            '<member><name>faultString</name><value><string>RuntimeError: nope</string></value></member>' +
            '</struct></value></fault></methodResponse>'
        expect(() => decodeMethodResponse(body)).toThrow(/fault 1: RuntimeError: nope/)
    })

    it('refuses a body that is not an xml-rpc response', () => {
        expect(() => decodeMethodResponse('<html><body>502 Bad Gateway</body></html>')).toThrow(/methodResponse/)
    })
})
