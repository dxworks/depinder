import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../../src/purl.js'
import {mavenFetcher} from '../../../src/registries/maven/index.js'
import {artifactBase} from '../../../src/registries/maven/metadata.js'
import {
    BASE,
    body,
    calls,
    centralHandler,
    context,
    GUAVA,
    guavaParentPom,
    guavaPom,
    headersOf,
    metadataXml,
    PARENT_BASE,
    records,
    resetStubs,
    stubFetch,
} from './maven.helpers.js'

beforeEach(() => {
    resetStubs()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('maven urls', () => {
    it('turns the group id into a path and never touches search.maven.org', () => {
        expect(artifactBase(parsePurl(GUAVA))).toBe(BASE)
        expect(artifactBase(parsePurl('pkg:maven/org.apache.commons/commons-lang3'))).toBe(
            'https://repo1.maven.org/maven2/org/apache/commons/commons-lang3',
        )
    })
})

describe('maven fetchPackage', () => {
    it('reads metadata, listing and POM, in that order', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(calls.map(c => c.url)).toEqual([
            `${BASE}/maven-metadata.xml`,
            `${BASE}/`,
            `${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`,
            `${PARENT_BASE}/32.1.2-jre/guava-parent-32.1.2-jre.pom`,
        ])
        expect(result).not.toBeNull()
        expect(result!.sources).toEqual(['repo1.maven.org'])
        expect(records).toHaveLength(4)
        expect(records[0]).toMatchObject({source: 'repo1.maven.org', status: 200, error: null})
    })

    it('maps every version in the metadata, dated from the directory listing', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(result!.versions.map(v => v.version)).toEqual([
            'r09',
            '10.0-rc1',
            '10.0',
            '31.1-android',
            '31.1-jre',
            '32.1.2-android',
            '32.1.2-jre',
        ])
        expect(byVersion.get('32.1.2-jre')!.releasedAt?.toISOString()).toBe('2023-08-01T21:21:00.000Z')
        expect(byVersion.get('r09')!.releasedAt?.toISOString()).toBe('2011-04-08T15:00:00.000Z')
        // In the metadata, absent from the listing: no date rather than a borrowed one.
        expect(byVersion.get('31.1-android')!.releasedAt).toBeNull()
        // In the listing, absent from the metadata: not a published version.
        expect(byVersion.has('33.0.0-jre')).toBe(false)
        expect(result!.versions.every(v => !v.yanked)).toBe(true)
    })

    it('applies the maven pre-release carve-out from latest.ts', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('10.0-rc1')!.prerelease).toBe(true)
        // `-jre` and `-android` are flavours, not pre-release tags.
        expect(byVersion.get('32.1.2-jre')!.prerelease).toBe(false)
        expect(byVersion.get('31.1-android')!.prerelease).toBe(false)
        expect(byVersion.get('r09')!.prerelease).toBe(false)
    })

    it('reports <release> as the registry designation', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(result!.registryLatest).toBe('32.1.2-jre')
    })

    it('leaves registryLatest undefined when <release> is absent', async () => {
        const noRelease = metadataXml.replace('<release>32.1.2-jre</release>', '')
        stubFetch(centralHandler({[`${BASE}/maven-metadata.xml`]: () => body(noRelease)}))
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(result!.registryLatest).toBeUndefined()
    })

    it('inherits licenses, homepage and scm from the parent POM, keeping the child description', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(result!.licenses).toEqual(['Apache License, Version 2.0'])
        expect(result!.homepageUrl).toBe('https://github.com/google/guava')
        expect(result!.repoUrl).toBe('https://github.com/google/guava')
        // The child POM has its own description; only the missing fields come from the parent.
        expect(result!.description).toBe(
            "Guava is a suite of core and expanded libraries that include utility classes, Google's " +
                'collections, I/O classes, and much more.',
        )
    })

    it('gives every version the library licenses by default', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(result!.versions.every(v => v.licenses.join() === 'Apache License, Version 2.0')).toBe(true)
        // One POM, not one per version.
        expect(calls.filter(c => c.url.endsWith('.pom'))).toHaveLength(2)
    })

    it('falls through to the next newest version when a POM is missing', async () => {
        stubFetch(
            centralHandler({
                [`${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`]: () => body('gone', 404),
                [`${BASE}/32.1.2-android/guava-32.1.2-android.pom`]: () => body(guavaParentPom),
            }),
        )
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(calls.map(c => c.url)).toContain(`${BASE}/32.1.2-android/guava-32.1.2-android.pom`)
        expect(result!.licenses).toEqual(['Apache License, Version 2.0'])
    })

    it('gives up after five missing POMs rather than walking the whole version list', async () => {
        stubFetch(centralHandler({[`${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`]: () => body('gone', 404)}))
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(calls.filter(c => c.url.endsWith('.pom'))).toHaveLength(5)
        expect(result!.licenses).toEqual([])
        expect(result!.versions.every(v => v.licenses.length === 0)).toBe(true)
    })

    it('stops the parent walk on an unresolved ${...} placeholder instead of crashing', async () => {
        const placeholderPom = guavaPom.replace(
            '<version>32.1.2-jre</version>',
            '<version>${project.version}</version>',
        )
        stubFetch(centralHandler({[`${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`]: () => body(placeholderPom)}))
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(calls.filter(c => c.url.includes('guava-parent'))).toHaveLength(0)
        expect(result!.licenses).toEqual([])
    })

    it('returns null when the artifact does not exist', async () => {
        stubFetch(() => body('not found', 404))
        expect(await mavenFetcher.fetchPackage(parsePurl('pkg:maven/com.example/nope'), context())).toBeNull()
        expect(calls).toHaveLength(1)
    })

    it('throws on a 5xx so the queue retries', async () => {
        stubFetch(() => body('boom', 503))
        await expect(mavenFetcher.fetchPackage(parsePurl(GUAVA), context())).rejects.toThrow(/503/)
    })

    it('keeps the versions when the directory listing is missing', async () => {
        stubFetch(centralHandler({[`${BASE}/`]: () => body('gone', 404)}))
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(result!.versions).toHaveLength(7)
        expect(result!.versions.every(v => v.releasedAt === null)).toBe(true)
    })

    it('sends the identifying user agent', async () => {
        stubFetch(centralHandler())
        await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(headersOf(calls[0])['user-agent']).toMatch(/^depinder /)
    })
})

describe('maven per-version licenses', () => {
    const pomFor = (license: string): string =>
        `<project><licenses><license><name>${license}</name></license></licenses></project>`

    it('fetches a POM per version when the option is on', async () => {
        stubFetch(
            centralHandler({
                [`${BASE}/r09/guava-r09.pom`]: () => body(pomFor('Apache 2')),
                [`${BASE}/10.0/guava-10.0.pom`]: () => body(pomFor('Apache 2')),
                [`${BASE}/10.0-rc1/guava-10.0-rc1.pom`]: () => body('gone', 404),
            }),
        )
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context(true))
        const byVersion = new Map(result!.versions.map(v => [v.version, v]))

        expect(byVersion.get('r09')!.licenses).toEqual(['Apache 2'])
        expect(byVersion.get('10.0')!.licenses).toEqual(['Apache 2'])
        // A version with no POM of its own falls back to the library-level list.
        expect(byVersion.get('10.0-rc1')!.licenses).toEqual(['Apache License, Version 2.0'])
        expect(calls.filter(c => c.url === `${BASE}/r09/guava-r09.pom`)).toHaveLength(1)
        // library POM + parent + one per version
        expect(calls.filter(c => c.url.endsWith('.pom'))).toHaveLength(2 + 7)
    })
})
