import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {createHttpClient, resetLimiters, type FetchRecord} from '../../../src/resolver/registries/http.js'
import {nullLogger, parsePurl} from '@depinder/core'
import {
    classifierLicenses,
    packageFromProject,
    projectLicenses,
    pypiRegistry,
    type PypiProject,
} from '../../../src/resolver/registries/pypi/index.js'
import {decodeMethodResponse, encodeMethodCall} from '../../../src/resolver/registries/pypi/xmlrpc.js'
import type {FetchContext} from '../../../src/resolver/registries/types.js'

const text = (name: string): string => readFileSync(new URL(`../../fixtures/${name}`, import.meta.url), 'utf8')

const requests = JSON.parse(text('pypi-requests.json')) as PypiProject
const changelog = text('pypi-changelog.xml')

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]
let records: FetchRecord[]

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

function xml(body: string, status = 200): Response {
    return new Response(body, {status, headers: {'content-type': 'text/xml; charset=UTF-8'}})
}

function context(): FetchContext {
    return {
        http: createHttpClient({type: 'pypi', recorder: record => records.push(record)}),
        log: nullLogger,
        options: {mavenPerVersionLicenses: false},
    }
}

function feed() {
    if (pypiRegistry.feed.mode !== 'feed') throw new Error('pypi should be a feed-mode registry')
    return pypiRegistry.feed
}

beforeEach(() => {
    calls = []
    records = []
    resetLimiters()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('pypi fetchPackage', () => {
    it('reads the project JSON and normalises it', async () => {
        stubFetch(() => json(requests))
        const result = await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/requests'), context())

        expect(calls[0]?.url).toBe('https://pypi.org/pypi/requests/json')
        expect(result).not.toBeNull()
        // The summary, not the README that `description` holds.
        expect(result!.description).toBe('Python HTTP for Humans.')
        expect(result!.repoUrl).toBe('https://github.com/psf/requests')
        expect(result!.licenses).toEqual(['Apache-2.0'])
        expect(result!.registryLatest).toBe('2.34.2')
        expect(result!.sources).toEqual(['pypi.org'])
        expect(result!.versions).toHaveLength(5)
    })

    it('uses the PEP 503 name the purl was canonicalised to', async () => {
        stubFetch(() => json({info: {version: '5.4'}, releases: {}}))
        await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/zope.interface'), context())
        expect(calls[0]?.url).toBe('https://pypi.org/pypi/zope-interface/json')
    })

    it('dates a release from its earliest file and yanks it only when every file is yanked', async () => {
        stubFetch(() => json(requests))
        const result = await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/requests'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        // The wheel went up two seconds before the sdist; the release is as old as its oldest file.
        expect(byVersion.get('2.31.0')!.releasedAt?.toISOString()).toBe('2023-05-22T15:12:42.313Z')
        expect(byVersion.get('2.31.0')!.yanked).toBe(false)
        expect(byVersion.get('2.32.0')!.yanked).toBe(true)
        // A release whose files were all deleted is not a yank, it just has no date left.
        expect(byVersion.get('0.0.1')!.releasedAt).toBeNull()
        expect(byVersion.get('0.0.1')!.yanked).toBe(false)
    })

    it('flags PEP 440 pre-releases', async () => {
        stubFetch(() => json(requests))
        const result = await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/requests'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('3.0.0b1')!.prerelease).toBe(true)
        expect(byVersion.get('2.31.0')!.prerelease).toBe(false)
    })

    it('gives per-version licenses only to the current release, because that is all `info` covers', async () => {
        stubFetch(() => json(requests))
        const result = await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/requests'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('2.34.2')!.licenses).toEqual(['Apache-2.0'])
        expect(byVersion.get('2.31.0')!.licenses).toEqual([])
        expect(byVersion.get('3.0.0b1')!.licenses).toEqual([])
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({message: 'Not Found'}, 404))
        expect(await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/no-such-dist'), context())).toBeNull()
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({message: 'boom'}, 500))
        await expect(pypiRegistry.fetchPackage(parsePurl('pkg:pypi/requests'), context())).rejects.toThrow(/500/)
    })

    it('records every request for fetch_log', async () => {
        stubFetch(() => json(requests))
        await pypiRegistry.fetchPackage(parsePurl('pkg:pypi/requests'), context())
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({source: 'pypi.org', status: 200, error: null})
    })
})

describe('pypi license precedence', () => {
    it('prefers the PEP 639 expression', () => {
        expect(
            projectLicenses({
                license_expression: 'MIT OR Apache-2.0',
                license: 'BSD',
                classifiers: ['License :: OSI Approved :: ISC License (ISCL)'],
            }),
            // An SPDX expression is kept whole: splitting it would claim a license that was never granted.
        ).toEqual(['MIT OR Apache-2.0'])
    })

    it('takes a short `license` next', () => {
        expect(projectLicenses({license: 'BSD-3-Clause', classifiers: ['License :: OSI Approved :: MIT License']})) //
            .toEqual(['BSD-3-Clause'])
    })

    it('ignores a `license` that is the whole license text', () => {
        const fullText = `Copyright (c) 2026\n${'x'.repeat(200)}`
        expect(projectLicenses({license: fullText, classifiers: ['License :: OSI Approved :: MIT License']})) //
            .toEqual(['MIT'])
        expect(projectLicenses({license: 'y'.repeat(120), classifiers: ['License :: OSI Approved :: MIT License']})) //
            .toEqual(['MIT'])
    })

    it('falls back to the classifiers, mapped to SPDX ids', () => {
        expect(
            classifierLicenses([
                'Development Status :: 5 - Production/Stable',
                'License :: OSI Approved :: MIT License',
                'License :: OSI Approved :: Apache Software License',
                'License :: OSI Approved :: BSD License',
                'License :: OSI Approved :: GNU General Public License v3 (GPLv3)',
                'License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)',
                'License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)',
                'License :: OSI Approved :: ISC License (ISCL)',
            ]),
        ).toEqual(['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0-only', 'LGPL-3.0-only', 'MPL-2.0', 'ISC'])
    })

    it('keeps the tail of a classifier it has no mapping for, and drops the empty ones', () => {
        expect(classifierLicenses(['License :: Public Domain', 'License :: OSI Approved'])) //
            .toEqual(['Public Domain'])
    })

    it('says nothing rather than guessing when the project declares nothing', () => {
        expect(projectLicenses({})).toEqual([])
        expect(projectLicenses({license: '', license_expression: '', classifiers: []})).toEqual([])
    })
})

describe('pypi project urls', () => {
    it('prefers a Homepage url over the deprecated home_page field', () => {
        const doc: PypiProject = {
            info: {
                version: '1.0',
                home_page: 'https://old.example.com',
                project_urls: {Homepage: 'https://example.com'},
            },
        }
        expect(packageFromProject(doc).homepageUrl).toBe('https://example.com')
    })

    it('accepts a lowercase homepage key and falls back to home_page', () => {
        expect(
            packageFromProject({info: {project_urls: {homepage: 'https://example.com'}}}).homepageUrl, //
        ).toBe('https://example.com')
        expect(packageFromProject({info: {home_page: 'https://example.com'}}).homepageUrl).toBe('https://example.com')
    })

    it('finds the repository under any of the labels people use for it', () => {
        expect(packageFromProject({info: {project_urls: {'Source Code': 'https://github.com/a/b'}}}).repoUrl) //
            .toBe('https://github.com/a/b')
        expect(packageFromProject({info: {project_urls: {Repository: 'git+https://github.com/a/b.git'}}}).repoUrl) //
            .toBe('https://github.com/a/b')
        expect(packageFromProject({info: {project_urls: {Documentation: 'https://readthedocs.io'}}}).repoUrl) //
            .toBeUndefined()
    })
})

describe('pypi feed', () => {
    it('starts from the current changelog serial', async () => {
        stubFetch(() => xml('<?xml version="1.0"?><methodResponse><params><param><value><int>41125269</int></value></param></params></methodResponse>'))

        const cursor = await feed().initialCursor(context())

        expect(cursor).toBe('41125269')
        expect(calls[0]?.url).toBe('https://pypi.org/pypi')
        expect(calls[0]?.init?.method).toBe('POST')
        expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('text/xml')
        expect(String(calls[0]?.init?.body)).toContain('<methodName>changelog_last_serial</methodName>')
    })

    it('collapses the rows of one upload into one event per package and keeps the biggest serial', async () => {
        stubFetch(() => xml(changelog))

        const result = await feed().poll('41125229', context())

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
        const result = await feed().poll('41125237', context())
        expect(result.events).toEqual([])
        expect(result.cursor).toBe('41125237')
        expect(result.cursorTime).toBeNull()
    })

    it('throws when the changelog is unavailable', async () => {
        stubFetch(() => xml('<html>503</html>', 503))
        await expect(feed().poll('1', context())).rejects.toThrow(/503/)
    })

    it('refuses a cursor that is not an integer', async () => {
        stubFetch(() => xml(changelog))
        await expect(feed().poll('not-a-serial', context())).rejects.toThrow(/not an integer/)
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
