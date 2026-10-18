import {XMLParser} from 'fast-xml-parser'
import {HttpError} from '../../http/client.js'
import type {ParsedPurl} from '../../purl.js'
import {stringOrUndefined, toDate} from '../normalise.js'
import type {FetchContext, FetchedVersion} from '../types.js'

/**
 * What Maven Central says about an artifact before any POM is read: where it lives, the version
 * list and `<release>` in `maven-metadata.xml`, and the deploy dates in the directory listing. The
 * tiny XML accessors at the bottom are shared with `pom.ts`.
 */

const BASE = 'https://repo1.maven.org/maven2'
export const SOURCE = 'repo1.maven.org'

/**
 * How far `<release>` may lag the newest stable deploy before it is treated as stale.
 *
 * `maven-metadata.xml` is written by whatever deployed last, and Central's copy is sometimes years
 * out of date: `commons-collections:commons-collections` says `<release>20040616</release>`, an
 * artifact the directory listing dates to 2005-09-20, while the same file's `<lastUpdated>` is
 * 2015-11-14 — the week 3.2.2 shipped. Believing it costs both the latest version and, because the
 * 20040616 POM declares no `<licenses>`, the licence of every version.
 *
 * The window is what keeps guava working. Guava ships `-jre` and `-android` flavours of one release
 * together and points `<release>` at one of them, so `<release>` is legitimately not the newest
 * deploy. Measured over guava's 51 flavour pairs on 2026-09-17, the two deploys are at most 48
 * minutes apart (and the `-android` jar has landed as much as 15 minutes *after* the `-jre` one),
 * so a day of slack keeps every co-shipped set trusted while still catching a lag measured in
 * years. Anything in between — a `<release>` a week behind — is a stale metadata file, not a
 * flavour.
 */
const RELEASE_STALE_MS = 24 * 60 * 60 * 1000

/**
 * A directory listing row:
 * `<a href="32.1.2-jre/" title="32.1.2-jre/">32.1.2-jre/</a>   2023-08-01 21:21         -`
 * Only rows whose href ends in `/` are directories, which is what excludes `maven-metadata.xml`
 * and its four checksum files from the version list.
 */
const LISTING_ROW = /href="([^"/]+)\/"[^\n]*?(\d{4}-\d\d-\d\d \d\d:\d\d)/g

/**
 * `parseTagValue: false` is the one option that matters: strnum would turn the version `10.0`
 * into the number 10 and `1.10` into 1.1, and versions are strings.
 */
export const xml = new XMLParser({
    ignoreAttributes: true,
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
})

interface MavenMetadata {
    /** In the order the file lists them, which is oldest first. */
    versions: string[]
    /** `<versioning><release>`, when present and non-empty. */
    release?: string
}

/** `pkg:maven/com.google.guava/guava` -> `https://repo1.maven.org/maven2/com/google/guava/guava`. */
export function artifactBase(key: Pick<ParsedPurl, 'namespace' | 'name'>): string {
    const group = (key.namespace ?? '')
        .split('.')
        .filter(Boolean)
        .map(seg)
        .join('/')
    return `${BASE}/${group}/${seg(key.name)}`
}

export function seg(value: string): string {
    return encodeURIComponent(value)
}

// --- metadata -------------------------------------------------------------------------------

export function parseMetadata(text: string): MavenMetadata {
    const metadata = child(xml.parse(text), 'metadata')
    if (metadata == null) throw new Error('maven-metadata.xml has no <metadata> element')
    const versioning = child(metadata, 'versioning')
    const versions = list(child(child(versioning, 'versions'), 'version'))
        .map(textOf)
        .filter((v): v is string => !!v)
    return {versions, release: stringOrUndefined(textOf(child(versioning, 'release')))}
}

/**
 * `<release>`, or `undefined` when it names a pre-release or Central's copy of it is stale.
 *
 * `<release>` is the newest non-SNAPSHOT deploy, and the metadata plugin has no notion of a
 * milestone: `jakarta.mail-api` says `2.2.0-M1`, `ognl` `3.5.0-BETA7`, `kotlin-stdlib`
 * `2.5.0-Beta1`. A pre-release is never a latest, so those are withheld and the stable versions
 * decide.
 *
 * The staleness rule, in one sentence: distrust `<release>` when some stable version was deployed
 * more than `RELEASE_STALE_MS` after it. That leaves the case where `<release>` is legitimately
 * not the newest deploy alone — a co-shipped set of flavours (guava's `-jre` / `-android`) — and
 * catches the case where the metadata file simply was not rewritten.
 *
 * Distrust needs evidence, so anything we cannot date is trusted: a `<release>` missing from the
 * directory listing, or an artifact with no dated stable version to compare it against. A
 * `<release>` naming a version that is not in the list at all is passed through too — `computeLatest`
 * discards it anyway, and there is nothing to judge it by here.
 */
export function trustedRelease(versions: readonly FetchedVersion[], release: string | undefined): string | undefined {
    if (!release) return undefined

    const named = versions.find(v => v.version === release)
    if (named?.prerelease) return undefined
    if (!named?.releasedAt) return release

    let newestStable: number | undefined
    for (const candidate of versions) {
        if (candidate.prerelease || candidate.yanked || !candidate.releasedAt) continue
        const at = candidate.releasedAt.getTime()
        if (newestStable === undefined || at > newestStable) newestStable = at
    }
    if (newestStable === undefined) return release

    return newestStable - named.releasedAt.getTime() > RELEASE_STALE_MS ? undefined : release
}

// --- release dates --------------------------------------------------------------------------

export async function fetchReleaseDates(base: string, name: string, ctx: FetchContext): Promise<Map<string, Date>> {
    const response = await ctx.http.get(`${base}/`, {headers: {accept: 'text/html'}})
    if (response.status === 404) {
        // The metadata answered, so the artifact exists; a missing listing only costs us dates.
        ctx.log.debug('no directory listing', {package: name, url: response.url})
        return new Map()
    }
    if (!response.ok) {
        throw new HttpError(
            `${SOURCE} returned ${response.status} for the ${name} directory listing`,
            response.url,
            response.status,
        )
    }
    return parseListing(response.text)
}

/** Version directory -> deploy time. The listing states UTC. */
export function parseListing(html: string): Map<string, Date> {
    const out = new Map<string, Date>()
    for (const match of html.matchAll(LISTING_ROW)) {
        const version = match[1]
        const stamp = match[2]
        if (!version || !stamp) continue
        const [date, time] = stamp.split(' ')
        const parsed = toDate(new Date(Date.parse(`${date}T${time}:00Z`)))
        if (parsed) out.set(version, parsed)
    }
    return out
}

// --- tiny XML accessors ---------------------------------------------------------------------

/** A named child of a parsed element, or undefined for anything that is not an element. */
export function child(node: unknown, name: string): unknown {
    if (node == null || typeof node !== 'object' || Array.isArray(node)) return undefined
    return (node as Record<string, unknown>)[name]
}

/** The text of an element. An empty element parses to `''` or `{}`; both mean "no value". */
export function textOf(node: unknown): string | undefined {
    if (typeof node === 'string') return node.trim() || undefined
    if (typeof node === 'number' || typeof node === 'boolean') return String(node)
    if (node != null && typeof node === 'object' && !Array.isArray(node)) {
        const text = (node as Record<string, unknown>)['#text']
        return typeof text === 'string' ? text.trim() || undefined : undefined
    }
    return undefined
}

/** An element that may repeat parses to a value or to an array of them; always want the array. */
export function list(node: unknown): unknown[] {
    if (node == null) return []
    return Array.isArray(node) ? node : [node]
}
