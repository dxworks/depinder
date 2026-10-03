import {fromRegistryName, HttpError, registryName} from '@depinder/core'
import {isPrerelease} from './latest.js'
import {fetchLicenses, DEPS_DEV_SOURCE} from './deps-dev.js'
import {normaliseRepoUrl, toDate} from './shared.js'
import type {FeedEvent, FeedResult, FetchContext, FetchedVersion, Registry} from './types.js'

/**
 * golang — facts from the module proxy, licenses from deps.dev, freshness from the module index.
 *
 * Three hosts, because Go split the job three ways:
 *
 *  - `proxy.golang.org` is the registry of record for *what exists*: `@v/list` gives the tagged
 *    versions, `@v/<v>.info` the commit time of one, `@latest` the version `go get` would pick.
 *    It serves module zips and has no opinion on licensing, so there is nothing else to read.
 *  - `api.deps.dev` has already scanned those zips, so it is where `licenses[]` comes from
 *    (`./deps-dev.ts`). One request per version, which is why only the newest
 *    {@link MAX_LICENSE_VERSIONS} versions get one — a module with 400 tags would otherwise cost
 *    400 requests for licenses nobody asks about, and the versions people resolve are the recent
 *    ones. deps.dev scans a version some time after it is published, and the index tells us
 *    about it within a minute, so the fetch a feed event causes often asks too early and gets a
 *    404. That version is stored with no license, and the feed will never name it again, so the
 *    package asks to be fetched once more {@link LICENSE_RECHECK_AFTER_MS} later — for as long as
 *    the unknown version is younger than {@link LICENSE_RECHECK_WINDOW_MS}. Past that, deps.dev
 *    not knowing it is taken as its answer.
 *  - `index.golang.org` is the change feed, and unusually for the feeds we consume it carries a
 *    real timestamp per event, so `cursorTime` is an honest "how far behind the head are we"
 *    rather than npm's "how long since we looked".
 *
 * Two Go-specific spellings this file has to get right:
 *
 *  - **Path escaping.** The proxy serves a case-insensitive filesystem, so an uppercase letter in
 *    a module path or version is escaped as `!` + its lowercase form:
 *    `github.com/Azure/azure-sdk-for-go` is fetched as `github.com/!azure/azure-sdk-for-go`.
 *    Package *keys* keep the original casing (`purl.ts` leaves golang alone), because that is what
 *    everything else — the index feed, deps.dev, `go.mod` — spells.
 *  - **Pseudo-versions.** `v0.0.0-20230101120000-abcdef123456` is what the proxy invents for a
 *    commit with no tag. It is a pre-release by construction and must never win `latest`.
 */

const PROXY_URL = 'https://proxy.golang.org'
const INDEX_URL = 'https://index.golang.org/index'
const PROXY_SOURCE = 'proxy.golang.org'

/** How many versions get a deps.dev license lookup, newest first. Older ones get `[]`. */
export const MAX_LICENSE_VERSIONS = 50

/** How long after a fetch that met a version deps.dev does not know yet the package is fetched again. */
export const LICENSE_RECHECK_AFTER_MS = 6 * 3_600_000

/** How young an unknown version must be to be worth that re-check. Older, and deps.dev's 404 stands. */
export const LICENSE_RECHECK_WINDOW_MS = 7 * 86_400_000

const INDEX_LIMIT = 2000

/**
 * The `<14-digit timestamp>-<12 hex commit>` suffix the proxy appends to an untagged commit. Go
 * builds it three ways — `v0.0.0-<stamp>-<hash>` after no tag at all, `v1.2.3-0.<stamp>-<hash>`
 * after a release tag, `v1.2.3-pre.0.<stamp>-<hash>` after a pre-release tag — so the separator in
 * front of the timestamp is `-` or `.` depending on which.
 */
const PSEUDO_VERSION = /[-.]\d{14}-[0-9a-f]{12}$/

interface LatestResponse {
    Version?: string
    Time?: string
    Origin?: {URL?: string}
}

interface InfoResponse {
    Version?: string
    Time?: string
}

interface IndexRow {
    Path?: string
    Version?: string
    Timestamp?: string
}

export const golangRegistry: Registry = {
    type: 'golang',

    async fetchPackage(key, ctx) {
        const modulePath = registryName(key)
        const base = `${PROXY_URL}/${escapeModulePath(modulePath)}`

        const listed = await fetchVersionList(base, modulePath, ctx)
        if (listed === null) return null

        const latest = await fetchLatest(base, modulePath, ctx)
        // `@v/list` omits pseudo-versions, so for a module that was never tagged it is empty while
        // `@latest` still names the newest commit. That version is the only one we would ever have.
        const versionStrings = [...listed]
        if (latest?.Version && !versionStrings.includes(latest.Version)) versionStrings.push(latest.Version)

        const dated = await Promise.all(
            versionStrings.map(async version => ({
                version,
                releasedAt: await fetchReleaseTime(base, modulePath, version, latest, ctx),
                prerelease: isGoPrerelease(version),
                yanked: false, // the proxy is immutable: a version it has served is never withdrawn
            })),
        )

        const licenses = await fetchVersionLicenses(modulePath, dated, latest?.Version, ctx)
        const versions: FetchedVersion[] = dated.map(v => ({...v, licenses: licenses.get(v.version) ?? []}))
        const recheckAt = licenseRecheckAt(dated, licenses, Date.now())

        const repoUrl = normaliseRepoUrl(latest?.Origin?.URL)
        return {
            homepageUrl: repoUrl,
            repoUrl,
            licenses: packageLicenses(versions, latest?.Version),
            versions,
            registryLatest: latest?.Version,
            sources: [PROXY_SOURCE, DEPS_DEV_SOURCE],
            ...(recheckAt ? {recheckAt} : {}),
        }
    },

    feed: {
        mode: 'feed',
        intervalMs: 60_000,

        /** The index is addressed by time, so the head is simply "now". */
        async initialCursor(): Promise<string> {
            return new Date().toISOString()
        },

        /**
         * One batch of the module index. It is ordered by `Timestamp`, so the newest row of the
         * batch is the next cursor; a full batch means there is more, which the next tick reads.
         */
        async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
            const url = `${INDEX_URL}?since=${encodeURIComponent(cursor)}&limit=${INDEX_LIMIT}`
            const response = await ctx.http.get(url, {headers: {accept: 'text/plain'}})
            if (!response.ok) {
                throw new HttpError(
                    `index.golang.org returned ${response.status} for the module index`,
                    response.url,
                    response.status,
                )
            }

            // Newline-delimited JSON, one `{Path, Version, Timestamp}` per published module version.
            // A module that published three versions in the batch is one package to re-fetch, so
            // the events are deduplicated by path, keeping the newest timestamp seen for it.
            const byKey = new Map<string, FeedEvent>()
            let lastTimestamp: string | undefined
            for (const line of response.text.split('\n')) {
                const row = parseIndexRow(line)
                if (!row?.Path) continue
                if (row.Timestamp) lastTimestamp = row.Timestamp
                const packageKey = eventPackageKey(row.Path)
                if (!packageKey) continue
                const at = toDate(row.Timestamp)
                const existing = byKey.get(packageKey)
                if (existing) existing.at = at ?? existing.at
                else byKey.set(packageKey, {packageKey, at})
            }

            const cursorTime = toDate(lastTimestamp)
            return {
                events: [...byKey.values()],
                cursor: lastTimestamp ?? cursor,
                cursorTime,
                headTime: null,
            }
        },
    },
}

/**
 * The proxy's case-folding escape: every uppercase letter becomes `!` + lowercase, so that two
 * module paths differing only in case cannot collide on a case-insensitive filesystem. It applies
 * to versions as well as paths (`v1.0.0-RC1` -> `v1.0.0-!r!c1`).
 */
export function escapeModulePath(path: string): string {
    return path.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`)
}

/** Pre-release by semver, or a pseudo-version: an untagged commit is never a release. */
function isGoPrerelease(version: string): boolean {
    return isPseudoVersion(version) || isPrerelease('golang', version)
}

export function isPseudoVersion(version: string): boolean {
    return PSEUDO_VERSION.test(version.trim())
}

/** `null` when the proxy has never heard of the module; throws on anything else unusable. */
async function fetchVersionList(base: string, modulePath: string, ctx: FetchContext): Promise<string[] | null> {
    const response = await ctx.http.get(`${base}/@v/list`, {headers: {accept: 'text/plain'}})
    // 410 Gone is what the proxy answers for a module it refuses to serve (excluded, or a repo
    // that has disappeared). Same meaning for us as a 404: no such package.
    if (response.status === 404 || response.status === 410) return null
    if (!response.ok) {
        throw new HttpError(
            `${PROXY_SOURCE} returned ${response.status} for ${modulePath}/@v/list`,
            response.url,
            response.status,
        )
    }
    // An empty body is a valid answer: the module exists but has no tagged versions.
    return response.text
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
}

/** `undefined` when the proxy has no latest to offer; that is normal, not an error. */
async function fetchLatest(base: string, modulePath: string, ctx: FetchContext): Promise<LatestResponse | undefined> {
    const response = await ctx.http.get(`${base}/@latest`)
    if (response.status === 404 || response.status === 410) return undefined
    if (!response.ok) {
        throw new HttpError(
            `${PROXY_SOURCE} returned ${response.status} for ${modulePath}/@latest`,
            response.url,
            response.status,
        )
    }
    return response.json<LatestResponse>()
}

/**
 * The commit time of one version. `@latest` already carries the time of the version it names, so
 * that one costs no extra request. Concurrency is the limiter's business: every call here goes
 * through `ctx.http`, so a module with 300 versions queues 300 requests 8 at a time rather than
 * opening 300 sockets.
 */
async function fetchReleaseTime(
    base: string,
    modulePath: string,
    version: string,
    latest: LatestResponse | undefined,
    ctx: FetchContext,
): Promise<Date | null> {
    if (latest?.Version === version && latest.Time) return toDate(latest.Time)

    const response = await ctx.http.get(`${base}/@v/${escapeModulePath(version)}.info`)
    // A version listed but not resolvable (a tag the proxy cannot build a zip for) still exists as
    // far as the list is concerned; we keep it, dateless, rather than dropping a version people
    // may well have in a go.mod.
    if (response.status === 404 || response.status === 410) return null
    if (!response.ok) {
        throw new HttpError(
            `${PROXY_SOURCE} returned ${response.status} for ${modulePath}@${version}`,
            response.url,
            response.status,
        )
    }
    return toDate(response.json<InfoResponse>().Time)
}

/**
 * deps.dev licenses for the newest {@link MAX_LICENSE_VERSIONS} versions, plus whichever version
 * `@latest` names even if it falls outside that window, because that is the one the library-level
 * license list is taken from. A version deps.dev has no record of maps to `null`.
 */
async function fetchVersionLicenses(
    modulePath: string,
    versions: readonly {version: string; releasedAt: Date | null}[],
    registryLatest: string | undefined,
    ctx: FetchContext,
): Promise<Map<string, string[] | null>> {
    const newestFirst = [...versions].sort(byReleasedAtDesc)
    const wanted = new Set(newestFirst.slice(0, MAX_LICENSE_VERSIONS).map(v => v.version))
    if (registryLatest && versions.some(v => v.version === registryLatest)) wanted.add(registryLatest)

    const entries = await Promise.all(
        [...wanted].map(async version => [version, await fetchLicenses(modulePath, version, ctx)] as const),
    )
    return new Map(entries)
}

/**
 * When to fetch the package again because deps.dev did not know one of its versions yet, or
 * `undefined` when nothing it was asked about is young enough to be still on its way. A version
 * with no date is never young: the proxy dates everything it can resolve.
 */
export function licenseRecheckAt(
    versions: readonly {version: string; releasedAt: Date | null}[],
    licenses: ReadonlyMap<string, string[] | null>,
    now: number,
): Date | undefined {
    const pending = versions.some(
        v =>
            licenses.get(v.version) === null &&
            v.releasedAt !== null &&
            now - v.releasedAt.getTime() < LICENSE_RECHECK_WINDOW_MS,
    )
    return pending ? new Date(now + LICENSE_RECHECK_AFTER_MS) : undefined
}

/** Undated versions sort last: the proxy answers with a time for everything it can resolve. */
function byReleasedAtDesc(a: {releasedAt: Date | null}, b: {releasedAt: Date | null}): number {
    const left = a.releasedAt?.getTime()
    const right = b.releasedAt?.getTime()
    if (left === undefined && right === undefined) return 0
    if (left === undefined) return 1
    if (right === undefined) return -1
    return right - left
}

/**
 * A Go module has no manifest-level license field, so the library-level list is the license of the
 * version `@latest` names, falling back to the newest version that has one.
 */
function packageLicenses(versions: readonly FetchedVersion[], registryLatest: string | undefined): string[] {
    const latest = registryLatest ? versions.find(v => v.version === registryLatest) : undefined
    if (latest && latest.licenses.length > 0) return latest.licenses
    return [...versions].sort(byReleasedAtDesc).find(v => v.licenses.length > 0)?.licenses ?? []
}

function parseIndexRow(line: string): IndexRow | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    try {
        return JSON.parse(trimmed) as IndexRow
    } catch {
        // A truncated last line would only happen if the index changed its framing; skipping it
        // costs one re-fetch on the next tick, whereas throwing would stall the cursor.
        return null
    }
}

/** Module paths are split into namespace/name by `purl.ts`, never by hand. */
function eventPackageKey(path: string): string | null {
    try {
        return fromRegistryName('golang', path).packageKey
    } catch {
        return null
    }
}
