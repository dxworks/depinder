import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {parsePurl} from '../../../src/purl.js'
import {mavenFetcher} from '../../../src/registries/maven/index.js'
import {parseListing, parseMetadata} from '../../../src/registries/maven/metadata.js'
import {parsePom} from '../../../src/registries/maven/pom.js'
import {
    BASE,
    body,
    calls,
    centralHandler,
    context,
    GUAVA,
    guavaParentPom,
    listingHtml,
    metadataXml,
    resetStubs,
    stubFetch,
} from './maven.helpers.js'

beforeEach(() => {
    resetStubs()
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('maven library POM licence walk', () => {
    const bare =
        '<project><groupId>com.google.guava</groupId><artifactId>guava</artifactId>' +
        '<version>32.1.2-jre</version><description>no licence here</description></project>'

    it('keeps walking the candidates when a POM declares and inherits no licence', async () => {
        stubFetch(
            centralHandler({
                [`${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`]: () => body(bare),
                [`${BASE}/32.1.2-android/guava-32.1.2-android.pom`]: () => body(guavaParentPom),
            }),
        )
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        expect(calls.map(c => c.url)).toContain(`${BASE}/32.1.2-android/guava-32.1.2-android.pom`)
        expect(result!.licenses).toEqual(['Apache License, Version 2.0'])
    })

    it('gives up after MAX_POM_TRIES and keeps the first POM it read', async () => {
        const healthy = centralHandler()
        stubFetch(url => (url.endsWith('.pom') ? body(bare) : healthy(url)))
        const result = await mavenFetcher.fetchPackage(parsePurl(GUAVA), context())

        // Five candidates, not the whole version list — an artifact that genuinely declares no
        // licence anywhere must not cost a request per version.
        expect(calls.filter(c => c.url.endsWith('.pom'))).toHaveLength(5)
        expect(result!.licenses).toEqual([])
        // The walk was for the licence; the description and URLs of the first POM are still ours.
        expect(result!.description).toBe('no licence here')
    })
})

describe('maven parsing', () => {
    it('reads the version list and <release> from maven-metadata.xml', () => {
        const metadata = parseMetadata(metadataXml)
        expect(metadata.versions).toHaveLength(7)
        expect(metadata.versions[0]).toBe('r09')
        expect(metadata.release).toBe('32.1.2-jre')
    })

    it('keeps versions as strings rather than letting them become numbers', () => {
        const metadata = parseMetadata(
            '<metadata><versioning><versions><version>10.0</version><version>1.10</version>' +
                '</versions></versioning></metadata>',
        )
        expect(metadata.versions).toEqual(['10.0', '1.10'])
    })

    it('handles an artifact with a single version', () => {
        const metadata = parseMetadata(
            '<metadata><versioning><versions><version>1.0</version></versions><release></release>' +
                '</versioning></metadata>',
        )
        expect(metadata.versions).toEqual(['1.0'])
        expect(metadata.release).toBeUndefined()
    })

    it('throws on a body that is not maven-metadata.xml', () => {
        expect(() => parseMetadata('<html><body>503</body></html>')).toThrow(/metadata/)
    })

    it('reads directory rows and ignores files and the parent link', () => {
        const dates = parseListing(listingHtml)
        expect(dates.get('32.1.2-jre')?.toISOString()).toBe('2023-08-01T21:21:00.000Z')
        expect(dates.get('10.0-rc1')?.toISOString()).toBe('2011-09-09T13:13:00.000Z')
        expect(dates.has('maven-metadata.xml')).toBe(false)
        expect(dates.has('..')).toBe(false)
        expect(dates.size).toBe(7)
    })

    it('falls back to the license url when a POM gives no license name', () => {
        const pom = parsePom(
            '<project><licenses><license><url>https://opensource.org/licenses/MIT</url></license>' +
                '</licenses></project>',
        )
        expect(pom.licenses).toEqual(['https://opensource.org/licenses/MIT'])
    })

    it('collects several licenses and strips the scm: prefix from a connection', () => {
        const pom = parsePom(
            '<project>' +
                '<licenses><license><name>MIT</name></license><license><name>Apache-2.0</name></license></licenses>' +
                '<scm><connection>scm:git:git@github.com:x/y.git</connection></scm>' +
                '</project>',
        )
        expect(pom.licenses).toEqual(['MIT', 'Apache-2.0'])
        expect(pom.repoUrl).toBe('https://github.com/x/y')
    })

    it('leaves ${...} placeholders as they are written', () => {
        const pom = parsePom('<project><url>${project.url}/child</url><description>x</description></project>')
        expect(pom.url).toBe('${project.url}/child')
    })

    it('returns nothing useful for a body that is not a POM', () => {
        expect(parsePom('<html><body>oops</body></html>')).toEqual({licenses: []})
    })
})
