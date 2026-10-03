import {HttpError} from '../http.js'
import {isPrerelease} from '../latest.js'
import {fromRegistryName, registryName} from '@depinder/core'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from '../shared.js'
import type {FeedEvent, FeedResult, FetchContext, FetchedPackage, FetchedVersion, Registry} from '../types.js'
import {decodeMethodResponse, encodeMethodCall, type XmlRpcValue} from './xmlrpc.js'

/**
 * pypi.
 *
 * Facts come from the legacy JSON API (`GET https://pypi.org/pypi/<name>/json`), which carries
 * every release, every file of every release and the project metadata in one response, so a
 * package costs exactly one request. The name in the URL is the PEP 503 normalised one that
 * `purl.ts` already produced; PyPI resolves normalised names itself.
 *
 * Two things this API does not give us:
 *
 *  - **Per-version licenses.** License metadata lives under `info`, which describes the *current*
 *    release only. So every version gets `licenses: []` except the one equal to `info.version`,
 *    which gets the library-level list. Claiming the current release's license for a five-year-old
 *    version would be a guess, and a license is exactly the wrong fact to guess at.
 *  - **A per-release date.** `releases[v]` is a list of uploaded *files*; the release date is the
 *    earliest upload among them. A release whose files were all deleted keeps its key with an
 *    empty list: it is not yanked, it simply has no date.
 *
 * Freshness comes from PyPI's XML-RPC changelog, the one part of the XML-RPC interface that is
 * still supported for mirroring. Its cursor is a monotonic "serial" and its entries carry unix
 * timestamps, so `cursorTime` is a real head-lag rather than a wall clock.
 *
 * The XML-RPC encoding and decoding live in `xmlrpc.ts`.
 */

const API_URL = 'https://pypi.org/pypi'
const SOURCE = 'pypi.org'

/** PyPI's XML-RPC endpoint is the same path as the JSON API; the method is what distinguishes it. */
const XMLRPC_URL = 'https://pypi.org/pypi'

interface ReleaseFile {
    upload_time_iso_8601?: unknown
    upload_time?: unknown
    yanked?: unknown
}

interface ProjectInfo {
    version?: unknown
    summary?: unknown
    home_page?: unknown
    license?: unknown
    license_expression?: unknown
    classifiers?: unknown
    project_urls?: Record<string, unknown> | null
}

export interface PypiProject {
    info?: ProjectInfo
    releases?: Record<string, ReleaseFile[] | null>
}

export const pypiRegistry: Registry = {
    type: 'pypi',

    async fetchPackage(key, ctx) {
        // Already PEP 503 normalised by `purl.ts`; PyPI serves normalised names directly.
        const name = registryName(key)
        const response = await ctx.http.get(`${API_URL}/${encodeURIComponent(name)}/json`)
        if (response.status === 404) return null
        if (!response.ok) {
            throw new HttpError(`${SOURCE} returned ${response.status} for ${name}`, response.url, response.status)
        }
        return packageFromProject(response.json<PypiProject>())
    },

    feed: {
        mode: 'feed',
        intervalMs: 60_000,

        /** The current changelog serial. Everything below it is already in the packages we hold. */
        async initialCursor(ctx: FetchContext): Promise<string> {
            const value = await xmlrpcCall(ctx, 'changelog_last_serial', [])
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new Error(`${SOURCE} returned a non-integer changelog_last_serial: ${JSON.stringify(value)}`)
            }
            return String(Math.trunc(value))
        },

        async poll(cursor: string, ctx: FetchContext): Promise<FeedResult> {
            const serial = Number.parseInt(cursor, 10)
            if (!Number.isFinite(serial)) throw new Error(`pypi feed cursor "${cursor}" is not an integer`)

            const value = await xmlrpcCall(ctx, 'changelog_since_serial', [serial])
            if (!Array.isArray(value)) {
                throw new Error(`${SOURCE} returned a non-array changelog_since_serial: ${typeof value}`)
            }

            let maxSerial = serial
            let maxTime: number | null = null
            // A single upload produces several rows ("new release", "add py3 file", "add source
            // file"); the worker only needs to know the package changed, so they collapse to one
            // event carrying the newest time seen for that package.
            const latestPerPackage = new Map<string, Date | null>()

            for (const row of value) {
                if (!Array.isArray(row)) continue
                const [name, , timestamp, , rowSerial] = row
                if (typeof rowSerial === 'number' && rowSerial > maxSerial) maxSerial = Math.trunc(rowSerial)
                const at = typeof timestamp === 'number' ? toDate(timestamp) : null
                if (at && (maxTime === null || at.getTime() > maxTime)) maxTime = at.getTime()
                if (typeof name !== 'string') continue
                const packageKey = eventPackageKey(name)
                if (!packageKey) continue
                const previous = latestPerPackage.get(packageKey)
                if (previous === undefined || (at && (previous === null || at.getTime() > previous.getTime()))) {
                    latestPerPackage.set(packageKey, at)
                }
            }

            const events: FeedEvent[] = [...latestPerPackage].map(([packageKey, at]) => ({packageKey, at}))
            return {
                events,
                cursor: String(maxSerial),
                cursorTime: maxTime === null ? null : new Date(maxTime),
                // PyPI publishes no head time of its own; the newest serial we consumed is it.
                headTime: null,
            }
        },
    },
}

function eventPackageKey(name: string): string | null {
    try {
        return fromRegistryName('pypi', name).packageKey
    } catch {
        return null
    }
}

// --- mapping ---------------------------------------------------------------------------------

/** Exported for the tests: the pure project-JSON -> FetchedPackage mapping. */
export function packageFromProject(doc: PypiProject): FetchedPackage {
    const info = doc.info ?? {}
    const registryLatest = stringOrUndefined(info.version)
    const licenses = projectLicenses(info)

    const versions: FetchedVersion[] = Object.entries(doc.releases ?? {}).map(([version, files]) => {
        const list = Array.isArray(files) ? files : []
        return {
            version,
            releasedAt: earliestUpload(list),
            // See the file header: `info` describes the current release, nothing else.
            licenses: registryLatest !== undefined && version === registryLatest ? licenses : [],
            prerelease: isPrerelease('pypi', version),
            // A release is withdrawn when every file of it is. One with no files at all was never
            // yanked — its files were deleted, which PyPI treats as a different thing.
            yanked: list.length > 0 && list.every(file => file.yanked === true),
        }
    })

    const projectUrls = info.project_urls ?? {}
    return {
        // `summary` is the one-liner. The long description is the whole README, which is not a
        // description in any sense the API's consumers mean.
        description: stringOrUndefined(info.summary),
        homepageUrl:
            stringOrUndefined(projectUrls.Homepage) ??
            stringOrUndefined(projectUrls.homepage) ??
            stringOrUndefined(info.home_page),
        repoUrl: repoUrlFrom(projectUrls),
        licenses,
        versions,
        registryLatest,
        sources: [SOURCE],
    }
}

/** The earliest file upload of a release. `null` when the release has no files left. */
function earliestUpload(files: ReleaseFile[]): Date | null {
    let earliest: Date | null = null
    for (const file of files) {
        const date = toDate(file.upload_time_iso_8601) ?? toDate(file.upload_time)
        if (date && (earliest === null || date.getTime() < earliest.getTime())) earliest = date
    }
    return earliest
}

const REPO_URL_KEY = /source|repository|code|github/i

function repoUrlFrom(projectUrls: Record<string, unknown>): string | undefined {
    for (const [label, url] of Object.entries(projectUrls)) {
        if (REPO_URL_KEY.test(label)) {
            const normalised = normaliseRepoUrl(url)
            if (normalised) return normalised
        }
    }
    return undefined
}

/**
 * License precedence, in the order PyPI itself deprecated things:
 *
 *  1. `license_expression` (PEP 639) — an SPDX expression, authoritative when present.
 *  2. `license` — a free-text field. Thousands of projects paste the entire license *text* into
 *     it, so anything long or multi-line is text rather than a name and is ignored.
 *  3. `License ::` trove classifiers, mapped to SPDX ids.
 */
export function projectLicenses(info: ProjectInfo): string[] {
    const expression = stringOrUndefined(info.license_expression)
    if (expression) return normaliseLicenses(expression)

    const license = stringOrUndefined(info.license)
    if (license && license.length < 100 && !license.includes('\n')) return normaliseLicenses(license)

    return classifierLicenses(info.classifiers)
}

/**
 * The classifiers that actually turn up. Anything not in here keeps the text after the last `::`,
 * which is a readable answer ("Public Domain", "Other/Proprietary License") even when it is not
 * an SPDX id.
 */
const CLASSIFIER_LICENSES: Record<string, string> = {
    'MIT License': 'MIT',
    'Apache Software License': 'Apache-2.0',
    'BSD License': 'BSD-3-Clause',
    'GNU General Public License v3 (GPLv3)': 'GPL-3.0-only',
    'GNU Lesser General Public License v3 (LGPLv3)': 'LGPL-3.0-only',
    'Mozilla Public License 2.0 (MPL 2.0)': 'MPL-2.0',
    'ISC License (ISCL)': 'ISC',
}

export function classifierLicenses(classifiers: unknown): string[] {
    if (!Array.isArray(classifiers)) return []
    const names: string[] = []
    for (const classifier of classifiers) {
        if (typeof classifier !== 'string' || !classifier.startsWith('License ::')) continue
        const tail = classifier.slice(classifier.lastIndexOf('::') + 2).trim()
        // `License :: OSI Approved` on its own says "some OSI license", which names nothing.
        if (!tail || tail === 'OSI Approved') continue
        names.push(CLASSIFIER_LICENSES[tail] ?? tail)
    }
    return normaliseLicenses(names)
}

// --- XML-RPC ---------------------------------------------------------------------------------

async function xmlrpcCall(ctx: FetchContext, method: string, params: (number | string)[]): Promise<XmlRpcValue> {
    const response = await ctx.http.request(XMLRPC_URL, {
        method: 'POST',
        headers: {'content-type': 'text/xml', accept: 'text/xml'},
        body: encodeMethodCall(method, params),
    })
    if (!response.ok) {
        throw new HttpError(`${SOURCE} returned ${response.status} for ${method}`, response.url, response.status)
    }
    return decodeMethodResponse(response.text)
}
