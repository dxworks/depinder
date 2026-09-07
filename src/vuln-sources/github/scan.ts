import fs from 'fs'
import path from 'path'
import {Vulnerability} from '../../extension-points/vulnerability-checker'
import {CycloneDxBom, parsePurl} from '../../plugins/sbom/cyclonedx'
import {packageKeys} from '../../plugins/sbom/local-scan'
import {defaultCacheDir, readEcosystem, readManifest} from './cache'
import {ecosystemForPurlType} from './ecosystems'
import {AdvisoryIndex, buildAdvisoryIndex, matchComponent} from './match'
import {log} from '../../utils/logging'
import {timePhaseSync} from '../../utils/profile'

/**
 * Scanning a CycloneDX SBOM against the cached GitHub advisories.
 *
 * This is the GitHub source's counterpart to `local-scan.ts`: same input (an SBOM file), same
 * output (a package-key -> Vulnerability[] index keyed exactly as `DepinderDependency.id`), so the
 * SBOM plugin can union the two without knowing which produced what.
 *
 * Unlike Trivy and Grype it needs no subprocess — only the cache on disk — so it is the source
 * that still works on a machine with no scanner binaries.
 */

export interface GithubScanResult {
    /** True iff at least one ecosystem in the SBOM had a cache to match against. */
    available: boolean
    index: Map<string, Vulnerability[]>
    /** Ecosystems present in the SBOM but absent from the cache — the reason for a thin result. */
    missingEcosystems: string[]
}

const EMPTY: GithubScanResult = {available: false, index: new Map(), missingEcosystems: []}

/** Every purl in an SBOM, parsed. Read once and reused by both the census and the scan. */
function componentPurls(sbomFile: string): {type: string, name: string, version: string, purl: string}[] {
    const bom = JSON.parse(fs.readFileSync(sbomFile, 'utf8')) as CycloneDxBom
    const parsed: {type: string, name: string, version: string, purl: string}[] = []
    for (const component of bom.components ?? []) {
        if (!component.purl) continue
        const purl = parsePurl(component.purl)
        if (purl) parsed.push({...purl, purl: component.purl})
    }
    return parsed
}

/**
 * The GitHub ecosystem names an SBOM needs, derived from its components' purl types.
 *
 * This is what makes refresh ecosystem-scoped: a Ruby project's SBOM asks for `rubygems` alone,
 * not for the 7,000 npm advisories it will never look at.
 */
export function ecosystemsInSbom(sbomFile: string): string[] {
    const found = new Set<string>()
    for (const component of componentPurls(sbomFile)) {
        const ecosystem = ecosystemForPurlType(component.type)
        if (ecosystem) found.add(ecosystem.name)
    }
    return [...found].sort()
}

export function ecosystemsInSboms(sbomFiles: string[]): string[] {
    const found = new Set<string>()
    for (const file of sbomFiles) {
        try {
            for (const ecosystem of ecosystemsInSbom(file)) found.add(ecosystem)
        } catch (e: any) {
            log.warn(`Could not read ecosystems from ${path.basename(file)}: ${e?.message ?? e}`)
        }
    }
    return [...found].sort()
}

/** Advisory indices are built once per ecosystem per process — each is thousands of records. */
const indexCache = new Map<string, AdvisoryIndex | undefined>()

function indexFor(cacheDir: string, ecosystem: string): AdvisoryIndex | undefined {
    const key = `${cacheDir}|${ecosystem}`
    if (indexCache.has(key)) return indexCache.get(key)
    const manifest = readManifest(cacheDir)
    let index: AdvisoryIndex | undefined
    if (manifest.ecosystems[ecosystem]) {
        try {
            index = buildAdvisoryIndex(readEcosystem(cacheDir, ecosystem))
            log.info(`GitHub advisories: ${index.advisoryCount} indexed for ${ecosystem}`)
        } catch (e: any) {
            log.warn(`Could not read the ${ecosystem} advisory cache: ${e?.message ?? e}`)
        }
    }
    indexCache.set(key, index)
    return index
}

function scanFile(sbomFile: string, cacheDir: string): GithubScanResult {
    if (!fs.existsSync(sbomFile)) {
        log.warn(`GitHub advisory scan skipped: ${sbomFile} does not exist`)
        return EMPTY
    }

    const components = componentPurls(sbomFile)
    const index = new Map<string, Vulnerability[]>()
    const missing = new Set<string>()
    let available = false
    let findings = 0

    for (const component of components) {
        const ecosystem = ecosystemForPurlType(component.type)
        if (!ecosystem) continue
        const advisories = indexFor(cacheDir, ecosystem.name)
        if (!advisories) {
            missing.add(ecosystem.name)
            continue
        }
        available = true
        const matches = matchComponent(advisories, ecosystem.name, component.name, component.version)
        if (matches.length === 0) continue
        findings += matches.length
        for (const key of packageKeys(component.purl, component.name, component.version).keys) {
            const list = index.get(key)
            if (list) list.push(...matches)
            else index.set(key, [...matches])
        }
    }

    log.info(`GitHub advisory scan of ${path.basename(sbomFile)}: ${findings} finding entries across ${index.size} package keys`
        + (missing.size > 0 ? ` (no cache for ${[...missing].join(', ')})` : ''))
    return {available, index, missingEcosystems: [...missing]}
}

/** One scan per SBOM file per process — many projects and six sbom-* plugins share each file. */
const scanCache = new Map<string, GithubScanResult>()

export function githubScanSbomFileOnce(sbomFile: string, cacheDir: string = defaultCacheDir()): GithubScanResult {
    const key = `${cacheDir}|${path.resolve(sbomFile)}`
    let result = scanCache.get(key)
    if (!result) {
        result = timePhaseSync('scan:github', () => scanFile(path.resolve(sbomFile), cacheDir))
        scanCache.set(key, result)
    }
    return result
}

/** Exposed for tests, which need each scan to start from a clean slate. */
export function clearGithubScanCache(): void {
    scanCache.clear()
    indexCache.clear()
}
