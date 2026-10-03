import {javaRegistrar, MavenCentralRegistrar, MavenRepositoryRegistrar, parseRepositoryListing} from '../src/plugins/java'

describe('repo1.maven.org directory listing', () => {
    // Captured shape of https://repo1.maven.org/maven2/org/slf4j/slf4j-api/ — a version directory
    // per row, dated to the minute; `maven-metadata.xml` and `..` rows carry no version.
    const html = `
<a href="../">../</a>
<a href="1.1.0/" title="1.1.0/">1.1.0/</a>                                            2006-12-20 22:31         -
<a href="2.0.9/" title="2.0.9/">2.0.9/</a>                                            2023-09-03 16:14         -
<a href="1.1.0-RC0/" title="1.1.0-RC0/">1.1.0-RC0/</a>                                  2006-11-09 20:49         -
<a href="maven-metadata.xml" title="maven-metadata.xml">maven-metadata.xml</a>       2025-01-01 00:00       2046
`
    it('reads each version with its deploy minute, newest first', () => {
        const rows = parseRepositoryListing(html)
        expect(rows.map(it => it.version)).toEqual(['2.0.9', '1.1.0', '1.1.0-RC0'])
        // The search index's timestamp for the same version is 2023-09-03T16:14:33Z.
        expect(rows[0].timestamp).toBe(Date.parse('2023-09-03T16:14:00Z'))
    })
})

describe('the Java registrar chain', () => {
    it('asks repo1.maven.org first and the search index only as a fallback', () => {
        // The search index answers with silently truncated version lists (httpclient5 stopped at
        // 5.6.1 while 5.6.4 was released), so the repository is the registrar of record.
        expect(javaRegistrar).toBeInstanceOf(MavenRepositoryRegistrar)
        expect((javaRegistrar as any).next).toBeInstanceOf(MavenCentralRegistrar)
    })
})

describe('MavenRepositoryRegistrar', () => {
    const metadata = `<metadata><versioning>
        <versions><version>5.6.1</version><version>5.6.4</version><version>5.7-alpha1</version></versions>
    </versioning></metadata>`
    const listing = `
<a href="5.6.1/" title="5.6.1/">5.6.1/</a>        2026-04-15 10:00         -
<a href="5.6.4/" title="5.6.4/">5.6.4/</a>        2026-08-13 09:09         -
<a href="5.7-alpha1/" title="5.7-alpha1/">5.7-alpha1/</a>  2026-08-20 09:00         -
<a href="5.6.9-staging/" title="5.6.9-staging/">5.6.9-staging/</a>  2026-09-01 09:00         -
`
    const pom = `<project><url>https://hc.apache.org/</url><licenses><license><name>Apache License, Version 2.0</name></license></licenses></project>`

    it('takes the version list from the repository, newest first, released versions only', async () => {
        const realFetch = global.fetch
        global.fetch = (async (url: string) => {
            const body = url.endsWith('maven-metadata.xml') ? metadata : url.endsWith('/') ? listing : url.endsWith('.pom') ? pom : ''
            return {status: body ? 200 : 404, text: async () => body} as any
        }) as any
        try {
            const info = await new MavenRepositoryRegistrar().retrieveFromRegistry('org.apache.httpcomponents.client5:httpclient5')
            expect(info.versions.map(it => it.version)).toEqual(['5.7-alpha1', '5.6.4', '5.6.1'])
            expect(info.versions[0].latest).toBe(true)
            expect(info.licenses).toEqual(['Apache License, Version 2.0'])
            expect(info.homepageUrl).toBe('https://hc.apache.org/')
        } finally {
            global.fetch = realFetch
        }
    })
})
