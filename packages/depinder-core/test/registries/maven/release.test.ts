import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {computeLatest, isPrerelease} from '../../../src/registries/latest.js'
import {parsePurl} from '../../../src/purl.js'
import {mavenFetcher} from '../../../src/registries/maven/index.js'
import {parseListing, parseMetadata, trustedRelease} from '../../../src/registries/maven/metadata.js'
import {pomCandidates} from '../../../src/registries/maven/pom.js'
import type {FetchedVersion} from '../../../src/registries/types.js'
import {
    APACHE_PARENT,
    BASE,
    body,
    calls,
    CC,
    CC_BASE,
    centralHandler,
    commonsHandler,
    context,
    fixture,
    GUAVA,
    listingHtml,
    PARENT_BASE,
    resetStubs,
    stubFetch,
} from './maven.helpers.js'

beforeEach(() => {
    resetStubs()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('maven stale <release>', () => {
    const version = (v: string, date: string | null, prerelease = false): FetchedVersion => ({
        version: v,
        releasedAt: date ? new Date(date) : null,
        licenses: [],
        prerelease,
        yanked: false,
    })

    it('distrusts a <release> that Central deployed years before the newest stable version', async () => {
        stubFetch(commonsHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(CC), context())

        // `<release>` names 20040616 (deployed 2005-09-20); 3.2.2 shipped 2015-11-12.
        expect(result!.registryLatest).toBeUndefined()
        // Which is what makes the shared policy fall back to newest-stable-by-date.
        expect(computeLatest('maven', result!.versions, result!.registryLatest).latest).toBe('3.2.2')
    })

    it('reads the library POM from the newest stable version, not from the stale <release>', async () => {
        stubFetch(commonsHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(CC), context())
        const urls = calls.map(c => c.url)

        expect(urls).not.toContain(`${CC_BASE}/20040616/commons-collections-20040616.pom`)
        expect(urls).toContain(`${CC_BASE}/3.2.2/commons-collections-3.2.2.pom`)
        // 3.2.2 declares no licence itself: it comes from commons-parent:39 -> apache:16.
        expect(urls).toContain(`${APACHE_PARENT}/16/apache-16.pom`)
        expect(result!.licenses).toEqual(['Apache License, Version 2.0'])
        expect(result!.versions.every(v => v.licenses.join() === 'Apache License, Version 2.0')).toBe(true)
        expect(result!.description).toBe('Types that extend and augment the Java Collections Framework.')
    })

    it("keeps guava's <release> when the co-shipped flavour landed minutes later", async () => {
        // Guava deploys `-android` and `-jre` within the hour and points <release> at one of them;
        // across guava's 51 flavour pairs the two deploys are at most 48 minutes apart.
        const staggered = listingHtml.replace(/(32\.1\.2-android\/<\/a>\s+2023-08-01 )21:21/, '$121:41')
        expect(staggered).not.toBe(listingHtml)
        stubFetch(centralHandler({[`${BASE}/`]: () => body(staggered)}))

        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(result!.registryLatest).toBe('32.1.2-jre')
        // And the flavour Central designated is still the one the library POM is read from.
        expect(calls.map(c => c.url)).toContain(`${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`)
    })

    it('distrusts <release> once a newer stable version is more than a day newer', async () => {
        const days = listingHtml.replace(/(32\.1\.2-android\/<\/a>\s+2023-08-0)1( 21:21)/, '$14$2')
        expect(days).not.toBe(listingHtml)
        stubFetch(centralHandler({[`${BASE}/`]: () => body(days)}))

        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(result!.registryLatest).toBeUndefined()
    })

    it('leaves a healthy artifact alone: guava keeps <release> and still reads one POM', async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(result!.registryLatest).toBe('32.1.2-jre')
        expect(computeLatest('maven', result!.versions, result!.registryLatest).latest).toBe('32.1.2-jre')
        expect(calls.filter(c => c.url.endsWith('.pom')).map(c => c.url)).toEqual([
            `${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`,
            `${PARENT_BASE}/32.1.2-jre/guava-parent-32.1.2-jre.pom`,
        ])
    })

    it('trusts <release> when there is no deploy date to judge it by', () => {
        // Central lists no date for 31.1-android, so there is no evidence of staleness.
        const versions = [version('31.1-android', null), version('32.1.2-jre', '2023-08-01T21:21:00Z')]
        expect(trustedRelease(versions, '31.1-android')).toBe('31.1-android')
    })

    it('ignores pre-releases and unknown versions when deciding what the newest stable is', () => {
        const versions = [
            version('1.0', '2020-01-01T00:00:00Z'),
            version('2.0-SNAPSHOT', '2024-01-01T00:00:00Z', true),
        ]
        // The only thing newer than <release> is a pre-release, so <release> stands.
        expect(trustedRelease(versions, '1.0')).toBe('1.0')
        // A <release> that names nothing we know about is left for computeLatest to discard.
        expect(trustedRelease(versions, '9.9')).toBe('9.9')
        expect(trustedRelease(versions, undefined)).toBeUndefined()
    })

    it('lets a stale <release> fall back to its place in the deploy order', () => {
        const stale = [version('20040616', '2005-09-20T05:46:00Z'), version('3.2.2', '2015-11-12T23:11:00Z')]
        expect(pomCandidates(stale, '20040616')).toEqual(['3.2.2', '20040616'])

        // A trusted <release> is still tried first, even when a co-shipped flavour is newer.
        const flavours = [
            version('32.1.2-android', '2023-08-01T21:41:00Z'),
            version('32.1.2-jre', '2023-08-01T21:21:00Z'),
        ]
        expect(pomCandidates(flavours, '32.1.2-jre')).toEqual(['32.1.2-jre', '32.1.2-android'])
    })
})

/**
 * Captured from Central on 2026-10-02. Each `maven-metadata.xml` names a `<release>` nobody should
 * be told to upgrade to:
 *  - byte-buddy: `1.18.14-jdk5`, a Java 5 flavour deployed seven minutes before the plain 1.18.14;
 *  - jakarta.mail-api: `2.2.0-M1`, a milestone (the newest stable is 2.1.5);
 *  - logkit: no `<release>` at all, and every version deployed in the same minute of a 2005 bulk
 *    import — including `20020529`, a date stamp that is older than 2.0, not newer.
 */
describe('maven <release> that is not a latest', () => {
    function fromCentral(name: string): FetchedVersion[] {
        const metadata = parseMetadata(fixture(`maven-${name}-metadata.xml`))
        const dates = parseListing(fixture(`maven-${name}-listing.html`))
        return metadata.versions.map(version => ({
            version,
            releasedAt: dates.get(version) ?? null,
            licenses: [],
            prerelease: isPrerelease('maven', version),
            yanked: false,
        }))
    }

    function latestOf(name: string): {release?: string; trusted?: string; latest?: string} {
        const release = parseMetadata(fixture(`maven-${name}-metadata.xml`)).release
        const versions = fromCentral(name)
        const trusted = trustedRelease(versions, release)
        return {release, trusted, latest: computeLatest('maven', versions, trusted).latest}
    }

    it('withholds a milestone <release> and lets the newest stable version win', () => {
        expect(latestOf('jakarta-mail-api')).toEqual({release: '2.2.0-M1', trusted: undefined, latest: '2.1.5'})
    })

    it('prefers the plain version over a qualified flavour of the same release', () => {
        expect(latestOf('byte-buddy')).toEqual({release: '1.18.14-jdk5', trusted: '1.18.14-jdk5', latest: '1.18.14'})
    })

    it('breaks a same-minute tie by version order, with a date stamp ranking lowest', () => {
        expect(latestOf('logkit')).toEqual({release: undefined, trusted: undefined, latest: '2.0'})
    })

    it("keeps guava's flavour, which has no plain sibling", async () => {
        stubFetch(centralHandler())
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())
        expect(computeLatest('maven', result!.versions, result!.registryLatest).latest).toBe('32.1.2-jre')
    })
})
