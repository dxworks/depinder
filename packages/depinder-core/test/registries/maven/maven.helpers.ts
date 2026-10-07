import {vi} from 'vitest'
import type {FetchContext} from '../../../src/registries/types.js'
import {fixtureText, testContext, type SeenRequest} from '../registry.helpers.js'

/** What the maven tests share: the Central fixtures, a stubbed `fetch` that records each call, and the URLs. */

export const fixture = fixtureText

export const metadataXml = fixture('maven-guava-metadata.xml')
export const listingHtml = fixture('maven-guava-listing.html')
export const guavaPom = fixture('maven-guava.pom')
export const guavaParentPom = fixture('maven-guava-parent.pom')

/**
 * commons-collections, captured from Central on 2026-09-17. Its `maven-metadata.xml` says
 * `<release>20040616</release>` — an artifact the directory listing dates to 2005-09-20 — while
 * `<lastUpdated>` is 2015-11-14, the week 3.2.2 shipped. Central is wrong, and the 20040616 POM
 * declares no licence at all, so believing `<release>` loses both the latest version and the
 * licence. See CR-5.
 */
export const ccMetadataXml = fixture('maven-commons-collections-metadata.xml')
export const ccListingHtml = fixture('maven-commons-collections-listing.html')
export const ccStalePom = fixture('maven-commons-collections-20040616.pom')
export const ccPom = fixture('maven-commons-collections-3.2.2.pom')
export const commonsParentPom = fixture('maven-commons-parent.pom')
export const apacheParentPom = fixture('maven-apache-parent.pom')

export const BASE = 'https://repo1.maven.org/maven2/com/google/guava/guava'
export const PARENT_BASE = 'https://repo1.maven.org/maven2/com/google/guava/guava-parent'
export const GUAVA = 'pkg:maven/com.google.guava/guava'

export const CC_BASE = 'https://repo1.maven.org/maven2/commons-collections/commons-collections'
export const COMMONS_PARENT = 'https://repo1.maven.org/maven2/org/apache/commons/commons-parent'
export const APACHE_PARENT = 'https://repo1.maven.org/maven2/org/apache/apache'
export const CC = 'pkg:maven/commons-collections/commons-collections'

export interface Call {
    url: string
    init?: RequestInit
}

export let calls: Call[]
export let records: SeenRequest[]

export function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
    vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        calls.push({url, init})
        return Promise.resolve(handler(url, init))
    })
}

export function body(text: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(status === 304 || status === 204 ? null : text, {status, headers})
}

/** The three-and-a-bit requests a healthy guava fetch makes, plus anything a test overrides. */
export function centralHandler(overrides: Record<string, () => Response> = {}): (url: string) => Response {
    const routes: Record<string, () => Response> = {
        [`${BASE}/maven-metadata.xml`]: () => body(metadataXml),
        [`${BASE}/`]: () => body(listingHtml),
        [`${BASE}/32.1.2-jre/guava-32.1.2-jre.pom`]: () => body(guavaPom),
        [`${PARENT_BASE}/32.1.2-jre/guava-parent-32.1.2-jre.pom`]: () => body(guavaParentPom),
        ...overrides,
    }
    return url => routes[url]?.() ?? body('not found', 404)
}

/**
 * commons-collections as Central really serves it: a stale `<release>`, a licence-free POM at that
 * version, and the licence two `<parent>` hops above 3.2.2 (commons-parent:39 -> apache:16).
 */
export function commonsHandler(overrides: Record<string, () => Response> = {}): (url: string) => Response {
    const routes: Record<string, () => Response> = {
        [`${CC_BASE}/maven-metadata.xml`]: () => body(ccMetadataXml),
        [`${CC_BASE}/`]: () => body(ccListingHtml),
        [`${CC_BASE}/20040616/commons-collections-20040616.pom`]: () => body(ccStalePom),
        [`${CC_BASE}/3.2.2/commons-collections-3.2.2.pom`]: () => body(ccPom),
        [`${COMMONS_PARENT}/39/commons-parent-39.pom`]: () => body(commonsParentPom),
        [`${APACHE_PARENT}/16/apache-16.pom`]: () => body(apacheParentPom),
        ...overrides,
    }
    return url => routes[url]?.() ?? body('not found', 404)
}

export function context(): FetchContext {
    return testContext(records)
}

export function headersOf(call: Call | undefined): Record<string, string> {
    return (call?.init?.headers ?? {}) as Record<string, string>
}

/** What every test starts from: no calls and no records. */
export function resetStubs(): void {
    calls = []
    records = []
}
