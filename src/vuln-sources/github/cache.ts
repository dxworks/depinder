import fs from 'fs'
import path from 'path'
import {GithubAdvisory} from './advisory'

/**
 * The on-disk advisory cache.
 *
 *     <cache-dir>/github-advisories/
 *         manifest.json      what was downloaded, when, and how much of it
 *         npm.json           every reviewed advisory for that ecosystem
 *         rubygems.json
 *         ...
 *
 * One file per ecosystem, because refresh is ecosystem-scoped: an SBOM that contains only gems
 * has no reason to re-read 7,000 npm advisories, and the manifest is what lets the analysis decide
 * that without opening the files.
 *
 * `<cache-dir>` defaults to `<cwd>/cache`, the same directory `json-cache.ts` keeps `libs.json` in,
 * so a project has exactly one cache location.
 */

export const CACHE_SUBDIR = 'github-advisories'
export const DEFAULT_MAX_AGE_HOURS = 24

export interface EcosystemManifestEntry {
    /** ISO 8601, the moment the download completed. */
    downloadedAt: string
    count: number
    /** The cursor URL of the last page fetched — the audit trail for a partial download. */
    lastPage?: string
    etag?: string
    /** Present when the download ended early; the file then holds a partial set. */
    error?: string
}

export interface AdvisoryManifest {
    version: 1
    ecosystems: {[ecosystem: string]: EcosystemManifestEntry}
}

const EMPTY_MANIFEST: AdvisoryManifest = {version: 1, ecosystems: {}}

export function defaultCacheDir(): string {
    return path.resolve(process.cwd(), 'cache')
}

export function advisoryDir(cacheDir: string = defaultCacheDir()): string {
    return path.resolve(cacheDir, CACHE_SUBDIR)
}

function manifestFile(cacheDir: string): string {
    return path.resolve(advisoryDir(cacheDir), 'manifest.json')
}

function ecosystemFile(cacheDir: string, ecosystem: string): string {
    return path.resolve(advisoryDir(cacheDir), `${ecosystem}.json`)
}

export function readManifest(cacheDir: string = defaultCacheDir()): AdvisoryManifest {
    const file = manifestFile(cacheDir)
    if (!fs.existsSync(file)) return {...EMPTY_MANIFEST, ecosystems: {}}
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AdvisoryManifest
        return {version: 1, ecosystems: parsed.ecosystems ?? {}}
    } catch {
        // A truncated manifest must not abort an analysis: treat it as "nothing is cached", which
        // makes the next download rewrite it.
        return {...EMPTY_MANIFEST, ecosystems: {}}
    }
}

export function writeEcosystem(
    cacheDir: string,
    ecosystem: string,
    advisories: GithubAdvisory[],
    entry: Omit<EcosystemManifestEntry, 'count'>
): void {
    fs.mkdirSync(advisoryDir(cacheDir), {recursive: true})
    fs.writeFileSync(ecosystemFile(cacheDir, ecosystem), JSON.stringify(advisories))
    const manifest = readManifest(cacheDir)
    manifest.ecosystems[ecosystem] = {...entry, count: advisories.length}
    fs.writeFileSync(manifestFile(cacheDir), JSON.stringify(manifest, null, 2))
}

export function readEcosystem(cacheDir: string, ecosystem: string): GithubAdvisory[] {
    const file = ecosystemFile(cacheDir, ecosystem)
    if (!fs.existsSync(file)) return []
    return JSON.parse(fs.readFileSync(file, 'utf8')) as GithubAdvisory[]
}

export function hasEcosystem(cacheDir: string, ecosystem: string): boolean {
    return fs.existsSync(ecosystemFile(cacheDir, ecosystem))
}

/** Missing, unreadable, or older than `maxAgeHours`. A partial download is always stale. */
export function isStale(
    manifest: AdvisoryManifest,
    ecosystem: string,
    maxAgeHours: number = DEFAULT_MAX_AGE_HOURS,
    now: number = Date.now()
): boolean {
    const entry = manifest.ecosystems[ecosystem]
    if (!entry || entry.error) return true
    const downloadedAt = Date.parse(entry.downloadedAt)
    if (Number.isNaN(downloadedAt)) return true
    return now - downloadedAt > maxAgeHours * 3600_000
}

/**
 * The ecosystems that need downloading before a run: those asked for that are missing from disk
 * or older than `maxAgeHours`.
 */
export function staleEcosystems(
    cacheDir: string,
    ecosystems: string[],
    maxAgeHours: number = DEFAULT_MAX_AGE_HOURS,
    now: number = Date.now()
): string[] {
    const manifest = readManifest(cacheDir)
    return ecosystems.filter(it =>
        !hasEcosystem(cacheDir, it) || isStale(manifest, it, maxAgeHours, now))
}
