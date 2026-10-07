import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../src/purl.js'
import {
    classifierLicenses,
    packageFromProject,
    projectLicenses,
    pypiFetcher,
    type PypiProject,
} from '../../src/registries/pypi.js'
import {fixtureJson, testContext, type SeenRequest} from './registry.helpers.js'

const requests = fixtureJson<PypiProject>('pypi-requests')

interface Call {
    url: string
    init?: RequestInit
}

let calls: Call[]
let records: SeenRequest[]

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

const context = () => testContext(records)

beforeEach(() => {
    calls = []
    records = []
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('pypi fetchPackage', () => {
    it('reads the project JSON and normalises it', async () => {
        stubFetch(() => json(requests))
        const result = await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/requests'), context())

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
        await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/zope.interface'), context())
        expect(calls[0]?.url).toBe('https://pypi.org/pypi/zope-interface/json')
    })

    it('dates a release from its earliest file and yanks it only when every file is yanked', async () => {
        stubFetch(() => json(requests))
        const result = await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/requests'), context())
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
        const result = await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/requests'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('3.0.0b1')!.prerelease).toBe(true)
        expect(byVersion.get('2.31.0')!.prerelease).toBe(false)
    })

    it('gives per-version licenses only to the current release, because that is all `info` covers', async () => {
        stubFetch(() => json(requests))
        const result = await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/requests'), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('2.34.2')!.licenses).toEqual(['Apache-2.0'])
        expect(byVersion.get('2.31.0')!.licenses).toEqual([])
        expect(byVersion.get('3.0.0b1')!.licenses).toEqual([])
    })

    it('returns null on 404', async () => {
        stubFetch(() => json({message: 'Not Found'}, 404))
        expect(await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/no-such-dist'), context())).toBeNull()
    })

    it('throws on 500 so the queue retries', async () => {
        stubFetch(() => json({message: 'boom'}, 500))
        await expect(pypiFetcher.fetchPackage(parsePurl('pkg:pypi/requests'), context())).rejects.toThrow(/500/)
    })

    it('reports every request it makes', async () => {
        stubFetch(() => json(requests))
        await pypiFetcher.fetchPackage(parsePurl('pkg:pypi/requests'), context())
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
