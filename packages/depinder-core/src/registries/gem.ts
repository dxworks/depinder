import {HttpError} from '../http/client.js'
import {registryName} from '../purl.js'
import {isPrerelease} from './latest.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './normalise.js'
import type {FetchedPackage, FetchedVersion, PackageFetcher} from './types.js'

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

 */

const API_URL = 'https://rubygems.org/api/v1'
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

export const gemFetcher: PackageFetcher = {
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
