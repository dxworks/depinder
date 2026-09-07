import fetch from 'node-fetch'
import {LibraryInfo, Registrar} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'

/**
 * Crate enrichment through the crates.io API.
 *
 * There is no native `rust` plugin — depinder never parsed Cargo.lock — so the SBOM route is the
 * only consumer of this registrar, and this file holds just the registrar and the checker
 * `sbom-rust` borrows, not a Plugin.
 *
 * One request answers everything: `GET /api/v1/crates/<name>` returns the crate with its newest
 * version and links, plus every version with its publication time and SPDX licence expression.
 * crates.io's crawler policy requires a User-Agent that identifies the client, and refuses
 * anonymous ones, hence the header.
 */

const CRATES_URL = 'https://crates.io/api/v1/crates'
const USER_AGENT = 'depinder (https://github.com/dxworks/depinder)'

interface CrateVersion {
    num: string
    created_at: string
    license?: string | null
    yanked?: boolean
    downloads?: number
}

interface CrateResponse {
    crate: {
        name: string
        description?: string | null
        homepage?: string | null
        repository?: string | null
        documentation?: string | null
        max_stable_version?: string | null
        newest_version?: string | null
        downloads?: number
    }
    versions: CrateVersion[]
}

export async function retrieveFromCratesIo(name: string): Promise<LibraryInfo> {
    const response = await fetch(`${CRATES_URL}/${encodeURIComponent(name)}`, {headers: {'User-Agent': USER_AGENT}})
    if (!response.ok) throw new Error(`crates.io returned ${response.status} for ${name}`)
    const data = await response.json() as CrateResponse

    // A yanked version is one the registry itself says not to use, so it is not a "newer version"
    // anyone could upgrade to and is left out.
    const versions = data.versions.filter(it => !it.yanked)
    const latest = data.crate.max_stable_version ?? data.crate.newest_version ?? undefined
    const newest = versions.find(it => it.num === latest) ?? versions[0]

    return {
        name: data.crate.name,
        description: data.crate.description ?? '',
        versions: versions.map(it => ({
            version: it.num,
            timestamp: Date.parse(it.created_at),
            latest: it.num === latest,
            licenses: it.license ? [it.license] : [],
            downloads: it.downloads,
        })),
        // The licence is per version on crates.io; the newest one stands for the crate.
        licenses: newest?.license ? [newest.license] : [],
        homepageUrl: data.crate.homepage ?? data.crate.repository ?? '',
        reposUrl: data.crate.repository ? [data.crate.repository] : [],
        documentationUrl: data.crate.documentation ?? undefined,
        downloads: data.crate.downloads,
        keywords: [],
    }
}

export const cratesRegistrar: Registrar = {
    retrieve: retrieveFromCratesIo,
}

export const rustChecker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'RUST',
    getPURL: (lib, ver) => `pkg:cargo/${lib}@${ver}`,
}
