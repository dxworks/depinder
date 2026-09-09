import fetch from 'node-fetch'
import {LibraryInfo, Registrar} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'

/**
 * Go module enrichment through the public module proxy.
 *
 * There is no native `go` plugin — depinder never parsed go.sum — so the SBOM route is the only
 * consumer of this registrar, and this file holds just the registrar and the checker `sbom-go`
 * borrows, not a Plugin.
 *
 * proxy.golang.org offers three read-only endpoints and no search, so a lookup is:
 *   GET <module>/@v/list       the tagged versions, one per line (empty for untagged modules)
 *   GET <module>/@latest       the version `go get` would pick, with its time and VCS origin
 *   GET <module>/@v/<v>.info   the publication time of one version
 * Times come one version per request, which is why `.info` is fetched concurrently and why the
 * result is worth its slot in the library cache. The proxy carries no licence information at all,
 * so `licenses` is left empty rather than guessed; the SBOM's own licence, when it has one, is what
 * the export falls back to.
 */

const PROXY_URL = 'https://proxy.golang.org'
const INFO_CONCURRENCY = 8

interface VersionInfo {
    Version: string
    Time?: string
    Origin?: {URL?: string}
}

/** The proxy case-encodes module paths: every upper-case letter becomes `!` + its lower-case. */
export function escapeModulePath(module: string): string {
    return module.replace(/[A-Z]/g, it => `!${it.toLowerCase()}`)
}

async function fetchInfo(url: string): Promise<VersionInfo | undefined> {
    const response = await fetch(url)
    // 404 and 410 are the proxy's two spellings of "no such version"; neither is an error here.
    if (response.status === 404 || response.status === 410) return undefined
    if (!response.ok) throw new Error(`${url} returned ${response.status}`)
    return await response.json() as VersionInfo
}

async function mapConcurrently<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let next = 0
    await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
        while (next < items.length) {
            const index = next++
            results[index] = await fn(items[index])
        }
    }))
    return results
}

export async function retrieveFromGoProxy(module: string): Promise<LibraryInfo> {
    const base = `${PROXY_URL}/${escapeModulePath(module)}`

    const listResponse = await fetch(`${base}/@v/list`)
    if (!listResponse.ok) throw new Error(`proxy.golang.org returned ${listResponse.status} for ${module}`)
    const listed = (await listResponse.text()).split('\n').map(it => it.trim()).filter(Boolean)

    // A module with no tags has an empty list and a pseudo-version as its latest; keep that one so
    // the library still records a version.
    const latest = await fetchInfo(`${base}/@latest`)
    const versions = latest && !listed.includes(latest.Version) ? [...listed, latest.Version] : listed

    const infos = await mapConcurrently(versions, INFO_CONCURRENCY, version => fetchInfo(`${base}/@v/${version}.info`))

    return {
        name: module,
        versions: versions.map((version, index) => ({
            version,
            timestamp: Date.parse(infos[index]?.Time ?? ''),
            latest: version === latest?.Version,
            licenses: [],
        })),
        licenses: [],
        homepageUrl: latest?.Origin?.URL || `https://pkg.go.dev/${module}`,
        reposUrl: latest?.Origin?.URL ? [latest.Origin.URL] : [],
        keywords: [],
    }
}

export const goRegistrar: Registrar = {
    retrieve: retrieveFromGoProxy,
}

export const goChecker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'GO',
    getPURL: (lib, ver) => `pkg:golang/${lib}@${ver}`,
}
