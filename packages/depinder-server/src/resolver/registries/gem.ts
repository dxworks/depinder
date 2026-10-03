import {HttpError} from './http.js'
import {isPrerelease} from './latest.js'
import {fromRegistryName, registryName} from '@depinder/core'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './shared.js'
import type {FeedEvent, FeedResult, FetchContext, FetchedPackage, FetchedVersion, Registry} from './types.js'

/**
 * gem — rubygems.org.
 *
 * Facts cost two requests. `api/v1/versions/<gem>.json` lists every version with its publish time,
 * its licenses and its own `prerelease` flag; `api/v1/gems/<gem>.json` adds the things that belong
 * to the gem rather than to a version — the description, the URLs, and the `version` rubygems
 * itself calls current. The second one is optional: if it 404s after the first succeeded we keep
 * what we have rather than throwing away a complete version list.
 *
 * Two rubygems-specific shapes worth knowing:
 *
 *  - **Platforms.** A gem can ship the same version several times, once per platform
 *    (`ruby`, `x86_64-linux`, `java`, …). Those are build artefacts of one release, not separate
 *    versions, and `package_version` is keyed by `purl@version` — so each `number` is emitted
 *    once, preferring the pure-ruby build and falling back to whatever platform exists when there
 *    is no `ruby` one.
 *  - **Yanks.** A yanked version is simply absent from `versions.json`; there is no flag to read.
 *    So every version we see is `yanked: false`, and a yank shows up as the version disappearing
 *    on the next fetch. The compact index feed *does* mark yanks (a leading `-`), which is exactly
 *    what makes the gem re-appear in the queue so that disappearance is noticed.
 *
 * Freshness comes from the compact index, `https://rubygems.org/versions`: 23 MB of append-only
 * text with `accept-ranges: bytes`. Downloading it every two minutes would be absurd, so the
 * cursor is a byte offset and each poll is a `HEAD` for the current size followed by a `Range`
 * request for the bytes appended since — see `poll` for why the `HEAD` is not optional. Like
 * npm's, its lines carry no timestamp, so `cursorTime` is the wall-clock time of the read: the lag
 * on `/feeds` answers "how long since we looked", not "how far behind the head are we".
 */

const API_URL = 'https://rubygems.org/api/v1'
const COMPACT_INDEX_URL = 'https://rubygems.org/versions'
const SOURCE = 'rubygems.org'

interface VersionEntry {
    number?: unknown
    created_at?: unknown
    licenses?: unknown
    prerelease?: unknown
    platform?: unknown
}

interface GemEntry {
    version?: unknown
    info?: unknown
    homepage_uri?: unknown
    source_code_uri?: unknown
    licenses?: unknown
    metadata?: {source_code_uri?: unknown}
}

export const gemRegistry: Registry = {
    type: 'gem',

    async fetchPackage(key, ctx) {
        const name = registryName(key)
        const versionsResponse = await ctx.http.get(`${API_URL}/versions/${encodeURIComponent(name)}.json`)
        if (versionsResponse.status === 404) return null
        if (!versionsResponse.ok) {
            throw new HttpError(
                `${SOURCE} returned ${versionsResponse.status} for versions of ${name}`,
                versionsResponse.url,
                versionsResponse.status,
            )
        }
        const versions = versionsFromEntries(versionsResponse.json<VersionEntry[]>())

        const gemResponse = await ctx.http.get(`${API_URL}/gems/${encodeURIComponent(name)}.json`)
        // The gem endpoint 404s for a gem whose versions are all yanked, and occasionally lags a
        // brand new gem. A complete version list with no description beats no answer at all.
        if (gemResponse.status === 404) {
            ctx.log.debug('rubygems has no gem document', {gem: name})
            return {licenses: [], versions, sources: [SOURCE]}
        }
        if (!gemResponse.ok) {
            throw new HttpError(
                `${SOURCE} returned ${gemResponse.status} for gem ${name}`,
                gemResponse.url,
                gemResponse.status,
            )
        }
        return withGemDocument(versions, gemResponse.json<GemEntry>())
    },

    feed: {
        mode: 'feed',
        intervalMs: 120_000,

        /**
         * The current size of the compact index, in bytes: everything before it is already in the
         * packages we hold.
         */
        async initialCursor(ctx: FetchContext): Promise<string> {
            return String(await compactIndexSize(ctx))
        },

        /**
         * The bytes appended since the stored offset.
         *
         * Every tick starts by asking how long the file is now, and that is not belt-and-braces:
         * rubygems.org is fronted by Fastly, which answers an unsatisfiable `Range` with **200 and
         * the whole 23 MB body** rather than the 416 the RFC calls for (probed 2026-09-16). Since
         * "the cursor is exactly at the end" is the normal answer on a quiet two-minute tick, a
         * bare `Range: bytes=<cursor>-` would download the entire index over and over. Comparing
         * against the size first turns that case into no request at all, and lets the range be
         * closed (`<cursor>-<end>`) so a rebuilt index is a mismatch we can see rather than 23 MB
         * we have to swallow.
         *
         * The cursor always lands on a newline boundary because only whole lines are ever
         * consumed, so a partial line at the end of a batch is left for the next poll instead of
         * being parsed half-read.
         */
        async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
            const offset = parseNumber(cursor) ?? 0
            const total = await compactIndexSize(ctx)
            const now = new Date()

            if (total === offset) return {events: [], cursor, cursorTime: now, headTime: null}
            if (total < offset) {
                // The index is shorter than our offset, so it is not the file the offset was
                // measured against. Re-anchor at the new head rather than replaying history.
                ctx.log.warn('rubygems compact index is shorter than the cursor, re-anchoring', {cursor, total})
                return {events: [], cursor: String(total), cursorTime: now, headTime: null}
            }

            const response = await ctx.http.get(COMPACT_INDEX_URL, {
                headers: {range: `bytes=${offset}-${total - 1}`, accept: 'text/plain'},
            })

            // A conforming cache answers 416 when the range is unsatisfiable. Fastly does not, but
            // the feed should not depend on which CDN is in front of rubygems today.
            if (response.status === 416) {
                return {events: [], cursor, cursorTime: now, headTime: null}
            }

            // 200 means the range was ignored — the index was rebuilt between the two requests.
            // Re-anchor at what we were served instead of turning 23 MB of history into events.
            if (response.status === 200) {
                const head = Buffer.byteLength(response.text, 'utf8')
                ctx.log.warn('rubygems compact index was rebuilt, re-anchoring at the head', {cursor, head})
                return {events: [], cursor: String(head), cursorTime: now, headTime: null}
            }

            if (response.status !== 206) {
                throw new HttpError(
                    `${SOURCE} returned ${response.status} for the compact index`,
                    response.url,
                    response.status,
                )
            }

            const {consumedBytes, names} = parseCompactIndex(response.text)
            const events: FeedEvent[] = []
            for (const gem of names) {
                const packageKey = eventPackageKey(gem)
                if (packageKey) events.push({packageKey, at: null})
            }
            return {
                events,
                cursor: String(offset + consumedBytes),
                // Compact index lines carry no timestamp: freshness is "when we last read it".
                cursorTime: now,
                headTime: null,
            }
        },
    },
}

/**
 * How many bytes the compact index is right now. A `HEAD` is enough and costs no body; the
 * one-byte `Range` request is the fallback for a cache that answers `HEAD` without a
 * `content-length`.
 */
async function compactIndexSize(ctx: FetchContext): Promise<number> {
    const head = await ctx.http.request(COMPACT_INDEX_URL, {method: 'HEAD'})
    if (head.ok) {
        const length = parseNumber(head.headers.get('content-length'))
        if (length !== null) return length
    }

    const probe = await ctx.http.get(COMPACT_INDEX_URL, {headers: {range: 'bytes=0-0', accept: 'text/plain'}})
    const total = totalFromContentRange(probe.headers.get('content-range'))
    if (total === null) {
        throw new HttpError(
            `${SOURCE} did not report the size of the compact index (status ${probe.status})`,
            probe.url,
            probe.status,
        )
    }
    return total
}

/**
 * The gem names in a slice of the compact index, and how many bytes of it were whole lines.
 *
 * Lines are `<name> <comma-separated versions, a leading '-' marks a yank> <md5>`. Only the name
 * matters to us: any line mentioning a gem means that gem changed, and `fetchPackage` re-reads the
 * whole version list anyway. Exported for the tests.
 */
export function parseCompactIndex(text: string): {consumedBytes: number; names: string[]} {
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) return {consumedBytes: 0, names: []}

    const complete = text.slice(0, lastNewline + 1)
    const names: string[] = []
    const seen = new Set<string>()

    for (const line of complete.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        // The file starts with a `created_at: …` line and a `---` separator. They are only in
        // range when the cursor is 0, but a rebuilt index can put us there.
        if (trimmed === '---' || trimmed.startsWith('created_at:')) continue
        const name = trimmed.split(' ', 1)[0]
        if (!name || seen.has(name)) continue
        seen.add(name)
        names.push(name)
    }

    return {consumedBytes: Buffer.byteLength(complete, 'utf8'), names}
}

/** Exported for the tests: `versions.json` -> one `FetchedVersion` per version number. */
function versionsFromEntries(entries: readonly VersionEntry[]): FetchedVersion[] {
    const byNumber = new Map<string, VersionEntry>()

    for (const entry of entries) {
        const number = stringOrUndefined(entry?.number)
        if (!number) continue
        const existing = byNumber.get(number)
        // One release, several platform builds: keep the pure-ruby one, or the first we saw when
        // the version was only ever published for a native platform.
        if (!existing || (entry.platform === 'ruby' && existing.platform !== 'ruby')) byNumber.set(number, entry)
    }

    return [...byNumber.entries()].map(([number, entry]) => ({
        version: number,
        releasedAt: toDate(entry.created_at),
        licenses: normaliseLicenses(entry.licenses),
        // rubygems applies Gem::Version's own pre-release rule, which knows that `1.0.0.beta` and
        // `1.0.0.pre1` are pre-releases though neither is semver. Trust it over our guess.
        prerelease: typeof entry.prerelease === 'boolean' ? entry.prerelease : isPrerelease('gem', number),
        // Yanked versions are absent from this list; there is nothing here to mark.
        yanked: false,
    }))
}

/** Exported for the tests: folds `gems/<name>.json` into the version list. */
function withGemDocument(versions: FetchedVersion[], doc: GemEntry): FetchedPackage {
    const registryLatest = stringOrUndefined(doc.version)
    const declared = normaliseLicenses(doc.licenses)
    const latestVersion = registryLatest ? versions.find(v => v.version === registryLatest) : undefined

    return {
        description: stringOrUndefined(doc.info),
        homepageUrl: stringOrUndefined(doc.homepage_uri),
        repoUrl: normaliseRepoUrl(doc.source_code_uri ?? doc.metadata?.source_code_uri),
        // Some gems declare licenses per version only; the current version's list is the closest
        // thing to a library-level answer.
        licenses: declared.length > 0 ? declared : (latestVersion?.licenses ?? []),
        versions,
        registryLatest,
        sources: [SOURCE],
    }
}

function eventPackageKey(name: string): string | null {
    try {
        return fromRegistryName('gem', name).packageKey
    } catch {
        return null
    }
}

/** `bytes 0-0/23388275` -> `23388275`; also `bytes * /23388275`, which is what a 416 carries. */
function totalFromContentRange(value: string | null): number | null {
    if (!value) return null
    const match = /\/(\d+)\s*$/.exec(value)
    return match ? Number(match[1]) : null
}

function parseNumber(value: string | null | undefined): number | null {
    if (value == null) return null
    const parsed = Number(value.trim())
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
