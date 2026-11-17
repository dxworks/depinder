import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {open} from 'node:fs/promises'
import {Readable} from 'node:stream'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'
import {createGunzip} from 'node:zlib'
import type {ScannerName} from './scanners.js'
import {json, UpstreamError, withDeadline} from './upstream.js'

/**
 * The scanners' own releases on GitHub, for the scanner update (`scanner-updater.ts`): which
 * release to take, what its files are called, and getting one binary out of a release safely.
 *
 * Nothing here decides whether a file is genuine; `signatures.ts` checks the checksums file, and
 * the checksums file then vouches for the archive. Everything here fails closed: an unexpected
 * name, size or shape is an error, never a guess.
 */

/** Where each tool is released. */
const RELEASE_REPOS: Record<ScannerName, string> = {
    trivy: 'aquasecurity/trivy',
    grype: 'anchore/grype',
}

/** One GitHub release, as much of it as we read. */
export interface GithubRelease {
    tag_name: string
    draft: boolean
    prerelease: boolean
    /** Null for a draft. */
    published_at: string | null
    assets: {name: string}[]
}

/** A strict `1.2.3` or `v1.2.3`, nothing else: no `-rc1`, no build suffix. */
function parseVersion(version: string): [number, number, number] | null {
    const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(version.trim())
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** < 0, 0, > 0. A version that does not parse sorts below every one that does. */
export function compareVersions(a: string, b: string): number {
    const [pa, pb] = [parseVersion(a), parseVersion(b)]
    if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0)
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]
}

interface Selection {
    /** The release to try, if any: the newest one that is stable, old enough, newer and not refused. */
    candidate?: {version: string, tag: string, release: GithubRelease}
    /** The newest stable release, whatever its age, for `/health`. */
    latest: string | null
}

const DAY_MS = 86_400_000
/** 05:00 UTC, when the depminer and depinder bump bots run each day. */
const DAILY_RUN_MS = Date.UTC(1970, 0, 1, 5)

/**
 * Newest publish time a release may have: `minAgeMs` before the last 05:00 UTC, the same cutoff
 * the CI bump bots use, so the server and depminer pick the same Trivy each day.
 */
export function releaseCutoff(now: number, minAgeMs: number): number {
    const lastRun = now - ((now - DAILY_RUN_MS) % DAY_MS + DAY_MS) % DAY_MS
    return lastRun - minAgeMs
}

/**
 * Picks the release to install from a list. Drafts, prereleases and anything whose tag is not a
 * plain `x.y.z` are ignored; so is a release published after `releaseCutoff` (the cooldown: a
 * hijacked release is usually found and pulled within days) and any version in `rejected`.
 */
export function selectRelease(releases: readonly GithubRelease[], options: {
    current: string
    minAgeMs: number
    now: number
    rejected: (version: string) => boolean
}): Selection {
    const stable = releases
        .filter(r => !r.draft && !r.prerelease && parseVersion(r.tag_name) && r.published_at)
        .map(r => ({version: r.tag_name.replace(/^v/, ''), tag: r.tag_name, release: r}))
        .sort((a, b) => compareVersions(b.version, a.version))
    const cutoff = releaseCutoff(options.now, options.minAgeMs)
    const candidate = stable.find(r => {
        const published = Date.parse(r.release.published_at!)
        return compareVersions(r.version, options.current) > 0
            && !Number.isNaN(published)
            && published <= cutoff
            && !options.rejected(r.version)
    })
    return {candidate, latest: stable[0]?.version ?? null}
}

/** The release's files we need, by the names each publisher gives them. */
interface ReleaseFiles {
    archive: string
    checksums: string
    /** The Sigstore bundle over `checksums`. */
    bundle: string
}

/** Each tool's archive name per CPU, as `process.arch` says it. Linux only: the image is. */
const ARCHIVES: Record<ScannerName, Partial<Record<NodeJS.Architecture, (v: string) => string>>> = {
    trivy: {x64: v => `trivy_${v}_Linux-64bit.tar.gz`, arm64: v => `trivy_${v}_Linux-ARM64.tar.gz`},
    grype: {x64: v => `grype_${v}_linux_amd64.tar.gz`, arm64: v => `grype_${v}_linux_arm64.tar.gz`},
}

export function supportedArch(arch: NodeJS.Architecture): boolean {
    return arch in ARCHIVES.trivy && arch in ARCHIVES.grype
}

export function releaseFiles(tool: ScannerName, version: string, arch: NodeJS.Architecture): ReleaseFiles {
    const archive = ARCHIVES[tool][arch]
    if (!archive) throw new Error(`no ${tool} release for CPU ${arch}`)
    const checksums = `${tool}_${version}_checksums.txt`
    return {archive: archive(version), checksums, bundle: `${checksums}.sigstore.json`}
}

/** The URL of a file of a release; built by us, never taken from the API's answer. */
export function assetUrl(tool: ScannerName, tag: string, name: string): string {
    return `https://github.com/${RELEASE_REPOS[tool]}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

/**
 * The sha256 the checksums file gives for `name` (`<64 hex>  <name>` per line, as goreleaser
 * writes it). Throws when it is not listed, or listed twice with two different sums.
 */
export function expectedSha256(checksums: string, name: string): string {
    const sums = new Set<string>()
    for (const line of checksums.split('\n')) {
        const match = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line)
        if (match && match[2] === name) sums.add(match[1]!.toLowerCase())
    }
    if (sums.size === 0) throw new Error(`checksums file has no entry for ${name}`)
    if (sums.size > 1) throw new Error(`checksums file has ${sums.size} different sums for ${name}`)
    return [...sums][0]!
}

interface FetchOptions {
    fetch?: typeof fetch
    timeoutMs?: number
    signal?: AbortSignal
}

/** The newest releases of `tool`, newest first; 30 covers months of patch releases. */
export async function fetchReleases(tool: ScannerName, options: FetchOptions = {}): Promise<GithubRelease[]> {
    const url = `https://api.github.com/repos/${RELEASE_REPOS[tool]}/releases?per_page=30`
    return withDeadline(options, async (signal, fetchFn) => {
        const response = await fetchFn(url, {headers: {accept: 'application/vnd.github+json'}, signal})
        if (!response.ok) throw new UpstreamError(`HTTP ${response.status} from ${url}`)
        const body = await json(response, url)
        if (!Array.isArray(body) || !body.every(isRelease)) throw new UpstreamError(`${url} is not a list of releases`)
        return body
    })
}

function isRelease(r: unknown): r is GithubRelease {
    const it = r as GithubRelease
    return typeof it === 'object' && it !== null && typeof it.tag_name === 'string' && typeof it.draft === 'boolean'
        && typeof it.prerelease === 'boolean' && (it.published_at === null || typeof it.published_at === 'string')
        && Array.isArray(it.assets) && it.assets.every(a => typeof a?.name === 'string')
}

/**
 * Downloads `url` into the new file `dest` and returns its sha256. More than `maxBytes` is an
 * error, not a truncation. The file is created, never overwritten.
 */
export async function downloadFile(url: string, dest: string, maxBytes: number, options: FetchOptions = {}): Promise<string> {
    return withDeadline(options, async (signal, fetchFn) => {
        const response = await fetchFn(url, {signal})
        if (!response.ok || !response.body) throw new UpstreamError(`HTTP ${response.status} from ${url}`)
        if (Number(response.headers.get('content-length')) > maxBytes) throw new UpstreamError(`${url} is over ${maxBytes} bytes`)
        const hash = createHash('sha256')
        const out = await open(dest, 'wx', 0o600)
        let bytes = 0
        try {
            for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>) as AsyncIterable<Buffer>) {
                bytes += chunk.length
                if (bytes > maxBytes) throw new UpstreamError(`${url} is over ${maxBytes} bytes`)
                hash.update(chunk)
                await out.write(chunk)
            }
        } finally {
            await out.close()
        }
        return hash.digest('hex')
    })
}

const BLOCK = 512

/**
 * Writes the one regular file called `member` (or `./member`) out of the `.tar.gz` at `archive`
 * into the new file `dest`, executable by its owner. Nothing else in the archive is written,
 * so no name in it can point anywhere; links, folders and other entries are skipped. Throws when
 * `member` is missing, there twice, over `maxBytes`, or the archive is cut short or corrupt.
 * Decompressing more than `4 × maxBytes` in all is refused (a gzip bomb).
 */
export async function extractFile(archive: string, member: string, dest: string, maxBytes: number): Promise<void> {
    const out = await open(dest, 'wx', 0o700)
    let found = false
    let remaining = 0
    let padding = 0
    let writing = false
    let total = 0
    let buffer: Buffer = Buffer.alloc(0)
    try {
        for await (const chunk of createReadStream(archive).pipe(createGunzip()) as AsyncIterable<Buffer>) {
            total += chunk.length
            if (total > 4 * maxBytes) throw new Error(`${archive} unpacks to more than ${4 * maxBytes} bytes`)
            buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk
            for (;;) {
                if (remaining > 0 || padding > 0) {
                    const take = Math.min(remaining > 0 ? remaining : padding, buffer.length)
                    if (take === 0) break
                    if (remaining > 0) {
                        if (writing) await out.write(buffer.subarray(0, take))
                        remaining -= take
                    } else {
                        padding -= take
                    }
                    buffer = buffer.subarray(take)
                    continue
                }
                if (buffer.length < BLOCK) break
                const header = buffer.subarray(0, BLOCK)
                buffer = buffer.subarray(BLOCK)
                writing = false
                if (header.every(b => b === 0)) continue
                const entry = readHeader(header)
                if (entry.regular && entry.name.replace(/^\.\//, '') === member) {
                    if (found) throw new Error(`${member} is in the archive twice`)
                    if (entry.size > maxBytes) throw new Error(`${member} is over ${maxBytes} bytes`)
                    found = true
                    writing = true
                }
                remaining = entry.size
                padding = (BLOCK - entry.size % BLOCK) % BLOCK
            }
        }
    } finally {
        await out.close()
    }
    if (remaining > 0) throw new Error(`${archive} is cut short`)
    if (!found) throw new Error(`${member} is not in the archive`)
}

/** One ustar header: its name (with the ustar prefix), size, and whether it is a plain file. */
function readHeader(header: Buffer): {name: string, size: number, regular: boolean} {
    const text = (from: number, length: number): string => {
        const field = header.subarray(from, from + length)
        const end = field.indexOf(0)
        return field.subarray(0, end < 0 ? length : end).toString('utf8')
    }
    const octal = (from: number, length: number): number => {
        const raw = text(from, length).trim()
        if (!/^[0-7]+$/.test(raw)) throw new Error('corrupt tar header')
        return parseInt(raw, 8)
    }
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!
    if (sum !== octal(148, 8)) throw new Error('corrupt tar header: checksum')
    const name = text(0, 100)
    const prefix = text(257, 6) === 'ustar' ? text(345, 155) : ''
    const type = header[156]
    return {name: prefix ? `${prefix}/${name}` : name, size: octal(124, 12), regular: type === 0x30 || type === 0}
}
