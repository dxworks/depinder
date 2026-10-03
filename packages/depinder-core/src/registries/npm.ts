import {HttpError} from '../http/client.js'
import {registryName} from '../purl.js'
import {isPrerelease} from './latest.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined, toDate} from './normalise.js'
import type {FetchedPackage, FetchedVersion, PackageFetcher} from './types.js'

/**
 * npm — the reference implementation of `PackageFetcher`.
 *
 * Facts come from the full packument (`GET https://registry.npmjs.org/<name>`), which carries
 * every version, every publish time and every per-version license in one response, so a package
 * costs exactly one request.
 */

const REGISTRY_URL = 'https://registry.npmjs.org'
const SOURCE = 'registry.npmjs.org'

interface PackumentVersion {
    license?: unknown
    licenses?: unknown
    deprecated?: string
}

interface Packument {
    name?: string
    description?: unknown
    homepage?: unknown
    repository?: unknown
    license?: unknown
    licenses?: unknown
    time?: Record<string, string>
    versions?: Record<string, PackumentVersion>
    'dist-tags'?: Record<string, string>
}

// [12] npm implements [10]. Its feed half, [14], is the server's registries/npm-feed.ts.
export const npmFetcher: PackageFetcher = {
    type: 'npm',

    // [13] The fetchPackage half of [10]: one GET of the packument = every version, date and license.
    async fetchPackage(key, ctx) {
        const name = registryName(key)
        const response = await ctx.http.get(`${REGISTRY_URL}/${encodePackageName(name)}`)
        if (response.status === 404) return null
        if (!response.ok) {
            throw new HttpError(`${SOURCE} returned ${response.status} for ${name}`, response.url, response.status)
        }
        return packageFromPackument(response.json<Packument>())
    },
}

/** `@scope/name` -> `@scope%2Fname`, which is how the registry wants a scoped package spelled. */
function encodePackageName(name: string): string {
    return name.replace(/\//g, '%2F')
}

/** Exported for the tests: the pure packument -> FetchedPackage mapping. */
export function packageFromPackument(doc: Packument): FetchedPackage {
    const time = doc.time ?? {}
    const versionDocs = doc.versions ?? {}
    const registryLatest = stringOrUndefined(doc['dist-tags']?.latest)

    const raw = Object.entries(versionDocs).map(([version, versionDoc]) => ({
        version,
        releasedAt: toDate(time[version]),
        // `license` is the modern field; `licenses[]` is the pre-2014 spelling still on old packages.
        licenses: normaliseLicenses(versionDoc?.license ?? versionDoc?.licenses),
        prerelease: isPrerelease('npm', version),
        // npm has no yank: an unpublished version simply leaves the packument. `deprecated` is a
        // warning to humans, not a withdrawal, so it does not affect `latest`.
        yanked: false,
    }))

    const packageLicenses = pickPackageLicenses(doc, raw, registryLatest)
    const versions: FetchedVersion[] = raw.map(v => ({
        ...v,
        licenses: v.licenses.length > 0 ? v.licenses : packageLicenses,
    }))

    return {
        description: stringOrUndefined(doc.description),
        homepageUrl: stringOrUndefined(doc.homepage),
        repoUrl: normaliseRepoUrl(doc.repository),
        licenses: packageLicenses,
        versions,
        registryLatest,
        sources: [SOURCE],
    }
}

function pickPackageLicenses(
    doc: Packument,
    versions: {version: string; licenses: string[]}[],
    registryLatest: string | undefined,
): string[] {
    const top = normaliseLicenses(doc.license ?? doc.licenses)
    if (top.length > 0) return top
    const latest = registryLatest ? versions.find(v => v.version === registryLatest) : undefined
    if (latest && latest.licenses.length > 0) return latest.licenses
    // Some old packages only ever declared a license on individual versions.
    return versions.findLast(v => v.licenses.length > 0)?.licenses ?? []
}
