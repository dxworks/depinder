import {Vulnerability} from '../extension-points/vulnerability-checker'
import {log as defaultLog} from '../utils/logging'
import {count} from '../utils/profile'
import {ResolverConfig} from '../resolver/config'

/**
 * The client for `POST {url}/vulnerabilities`: the purls of every SBOM in, Trivy and Grype findings
 * out, from databases kept on the server.
 *
 * It replaces running both scanners on this machine, and only when it can do so completely: every
 * chunk is posted at once, under one deadline, exactly once, and the answer is all or nothing. A
 * chunk that fails in any way — a status other than 200, a network error, the deadline, a body
 * that is not the answer — aborts the others, and the caller scans the SBOMs locally instead, as
 * it always has. Half the purls with server findings and half with none would read as half a
 * clean bill of health. Nothing is retried, not even a 503 busy with its `Retry-After`: the local
 * scan is the retry.
 *
 * The server's findings are already depinder's `Vulnerability`, merged Trivy + Grype with the same
 * code as `plugins/sbom/local-scan.ts`, and keyed by the purl exactly as it was sent. A sent purl
 * that is under neither `vulnerabilities` nor `unsupported` was scanned and is clean.
 *
 * Its state is its own: a failure here never turns the resolver off, nor the other way round.
 */

export interface VulnServerConfig {
    /** Base URL, without a trailing slash; the resolver's. */
    url: string
    /** Bearer token; the resolver's. */
    token: string
    /** One deadline for every chunk of the ask, from the first post. */
    maxWaitMs: number
    /** Distinct purls per request, at most the server's own cap. */
    chunkSize: number
}

/** The server's default `VULN_MAX_PURLS`: past it a request is a 413. */
export const MAX_VULN_CHUNK_SIZE = 5000
export const DEFAULT_VULN_MAX_WAIT_MS = 30_000

function positiveFromEnv(name: string, fallback: number, integer: boolean): number {
    const raw = process.env[name]
    if (!raw) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isInteger(parsed))) {
        defaultLog.warn(`Ignoring ${name}=${raw}: not a positive ${integer ? 'whole number' : 'number'}`)
        return fallback
    }
    return parsed
}

/**
 * The vulnerability server for this run, or `undefined` to scan locally as before.
 *
 * Same address and token as the resolver, so it exists exactly when the resolver does: no
 * token or `--no-resolver` (without `--vuln-server`) means no vulnerability server either.
 * `--no-vuln-server` turns it off alone. Whether the run then uses it also depends on `--vuln-source` (see `usesVulnServer`).
 */
export function vulnServerConfig(resolver: ResolverConfig | undefined, options: {vulnServer?: boolean} = {}): VulnServerConfig | undefined {
    if (!resolver || options.vulnServer === false) return undefined
    return {
        url: resolver.url,
        token: resolver.token,
        maxWaitMs: positiveFromEnv('DEPINDER_VULN_MAX_WAIT_MS', DEFAULT_VULN_MAX_WAIT_MS, false),
        chunkSize: Math.min(MAX_VULN_CHUNK_SIZE, positiveFromEnv('DEPINDER_VULN_CHUNK_SIZE', MAX_VULN_CHUNK_SIZE, true)),
    }
}

/**
 * The server always runs both scanners, so it stands in for the local scan only when the run asked
 * for both. `github` is matched locally either way and merged in.
 */
export function usesVulnServer(selection: {trivy: boolean, grype: boolean}): boolean {
    return selection.trivy && selection.grype
}

/** One database build, as the server reports what produced an answer. */
export interface VulnDatabaseBuild {
    built_at: string
    schema?: string
    age_seconds?: number
    stale?: boolean
}

export type UnsupportedReason = 'invalid' | 'unsupported_type' | 'no_version'

/** The answers of every chunk, put together. */
export interface VulnServerAnswer {
    /** Findings per purl, exactly as sent; only vulnerable purls are present. */
    vulnerabilities: Map<string, Vulnerability[]>
    /** The purls the server did not scan, and why. */
    unsupported: Map<string, UnsupportedReason | string>
    /**
     * Every distinct build that answered a chunk, per tool, oldest first. One in practice; two only
     * when a database was swapped while the chunks were being scanned.
     */
    databases: {trivy: VulnDatabaseBuild[], grype: VulnDatabaseBuild[]}
    /** Scanner versions; more than one only if the chunks met different server processes. */
    scanners: {trivy: string[], grype: string[]}
    /** How many distinct purls were sent, in how many requests. */
    purls: number
    requests: number
    /** `Server-Timing` durations, summed over the requests, in ms. */
    serverTiming: {[metric: string]: number}
}

export type VulnServerResult =
    | {ok: true, answer: VulnServerAnswer}
    | {ok: false, reason: string}

interface ChunkBody {
    vulnerabilities: {[purl: string]: Vulnerability[]}
    unsupported?: {purl: string, reason: string}[]
    databases?: {trivy?: VulnDatabaseBuild, grype?: VulnDatabaseBuild}
    scanners?: {trivy?: string, grype?: string}
}

class ChunkFailure extends Error {}

type Logger = Pick<typeof defaultLog, 'info' | 'warn'>

/** `queue;dur=0, trivy;dur=57, total;dur=871` -> `{queue: 0, trivy: 57, total: 871}`. */
export function parseServerTiming(header: string | null | undefined): {[metric: string]: number} {
    const timings: {[metric: string]: number} = {}
    for (const entry of (header ?? '').split(',')) {
        const [name, ...params] = entry.split(';').map(it => it.trim())
        if (!name) continue
        const dur = params.find(it => it.toLowerCase().startsWith('dur='))
        const ms = dur ? Number(dur.slice('dur='.length)) : NaN
        if (Number.isFinite(ms)) timings[name] = ms
    }
    return timings
}

function isObject(value: unknown): value is {[key: string]: unknown} {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The body is the answer it should be, or this throws why not. */
function validate(body: unknown): ChunkBody {
    if (!isObject(body) || !isObject(body.vulnerabilities)) throw new ChunkFailure('answer has no vulnerabilities object')
    for (const findings of Object.values(body.vulnerabilities)) {
        if (!Array.isArray(findings)) throw new ChunkFailure('answer has a purl whose findings are not a list')
    }
    if (body.unsupported !== undefined && !Array.isArray(body.unsupported)) throw new ChunkFailure('answer has a malformed unsupported list')
    if (body.databases !== undefined && !isObject(body.databases)) throw new ChunkFailure('answer has a malformed databases object')
    return body as unknown as ChunkBody
}

function addBuild(builds: VulnDatabaseBuild[], build: VulnDatabaseBuild | undefined): void {
    if (!build?.built_at) return
    if (builds.some(it => it.built_at === build.built_at && it.schema === build.schema)) return
    builds.push({built_at: build.built_at, schema: build.schema, age_seconds: build.age_seconds, stale: build.stale})
    builds.sort((a, b) => Date.parse(a.built_at) - Date.parse(b.built_at))
}

/**
 * Splits the distinct purls into chunks of at most `size`, in first-seen order. Unlike the
 * resolver's chunks there is nothing to keep together: the server scans each purl on its own.
 */
export function vulnChunks(purls: Iterable<string>, size: number): string[][] {
    const distinct = [...new Set(purls)]
    const chunks: string[][] = []
    for (let i = 0; i < distinct.length; i += size) chunks.push(distinct.slice(i, i + size))
    return chunks
}

/**
 * Asks the server for the findings of every purl, and returns all of them or why it could not.
 *
 * Never throws. Every chunk is posted at once and shares one deadline (`maxWaitMs`, from the first
 * post); the first chunk to fail aborts the rest, and its reason is the result.
 */
export async function fetchServerVulnerabilities(
    config: VulnServerConfig,
    purls: Iterable<string>,
    log: Logger = defaultLog,
): Promise<VulnServerResult> {
    const chunks = vulnChunks(purls, Math.max(1, Math.min(MAX_VULN_CHUNK_SIZE, config.chunkSize)))
    const answer: VulnServerAnswer = {
        vulnerabilities: new Map(), unsupported: new Map(),
        databases: {trivy: [], grype: []}, scanners: {trivy: [], grype: []},
        purls: chunks.reduce((sum, it) => sum + it.length, 0), requests: chunks.length, serverTiming: {},
    }
    if (chunks.length === 0) return {ok: true, answer}

    const controller = new AbortController()
    let failure: string | undefined
    const fail = (reason: string) => {
        if (failure !== undefined) return
        failure = reason
        controller.abort()
    }
    const timer = setTimeout(() => fail(`no complete answer within ${config.maxWaitMs} ms`), config.maxWaitMs)

    const askChunk = async (chunk: string[]): Promise<void> => {
        count('vuln:request')
        try {
            const response = await fetch(`${config.url}/vulnerabilities`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.token}`,
                    'Content-Type': 'application/json',
                    // As for the resolver: undici decodes br, but only asks for gzip by itself.
                    'Accept-Encoding': 'br, gzip',
                },
                body: JSON.stringify({purls: chunk}),
                signal: controller.signal,
            })
            if (!response.ok) {
                let detail = ''
                try {
                    const body = await response.json() as {error?: unknown, reason?: unknown}
                    detail = [body?.error, body?.reason].filter(it => typeof it === 'string' && it).join(': ')
                } catch {
                    // No readable body; the status says enough.
                }
                throw new ChunkFailure(`HTTP ${response.status}${detail ? ` (${detail})` : ''}`)
            }
            let parsed: unknown
            try {
                parsed = await response.json()
            } catch (e: any) {
                if (controller.signal.aborted) throw e
                throw new ChunkFailure(`unreadable answer: ${e?.message ?? e}`)
            }
            const body = validate(parsed)
            if (failure !== undefined) return
            const sent = new Set(chunk)
            for (const [purl, findings] of Object.entries(body.vulnerabilities)) {
                // Keyed on the purl as sent; anything else the answer names is not ours.
                if (sent.has(purl)) answer.vulnerabilities.set(purl, findings)
            }
            for (const item of body.unsupported ?? []) {
                if (item && sent.has(item.purl)) answer.unsupported.set(item.purl, item.reason)
            }
            addBuild(answer.databases.trivy, body.databases?.trivy)
            addBuild(answer.databases.grype, body.databases?.grype)
            for (const tool of ['trivy', 'grype'] as const) {
                const version = body.scanners?.[tool]
                if (version && !answer.scanners[tool].includes(version)) answer.scanners[tool].push(version)
            }
            for (const [metric, ms] of Object.entries(parseServerTiming(response.headers.get('server-timing')))) {
                answer.serverTiming[metric] = (answer.serverTiming[metric] ?? 0) + ms
            }
        } catch (e: any) {
            // An abort is the echo of a failure already recorded (or of the deadline); keep the first reason.
            fail(e instanceof ChunkFailure ? e.message : e?.message ?? String(e))
        }
    }

    try {
        await Promise.all(chunks.map(askChunk))
    } finally {
        clearTimeout(timer)
    }
    if (failure !== undefined) return {ok: false, reason: failure}

    let findings = 0
    for (const list of answer.vulnerabilities.values()) findings += list.length
    count('vuln:findings', findings)
    log.info(`Vulnerability server answered for ${answer.purls} purl(s) in ${answer.requests} request(s): `
        + `${findings} finding(s) on ${answer.vulnerabilities.size} purl(s), ${answer.unsupported.size} not scanned`)
    return {ok: true, answer}
}

function describeAge(seconds: number | undefined): string {
    if (seconds === undefined) return 'of unknown age'
    const hours = seconds / 3600
    return hours >= 48 ? `${Math.round(hours / 24)} days old` : `${Math.round(hours)} hours old`
}

/** One line per stale build the answer came from; empty when every build is current. */
export function staleBuildWarnings(answer: VulnServerAnswer): string[] {
    const warnings: string[] = []
    for (const tool of ['trivy', 'grype'] as const) {
        for (const build of answer.databases[tool]) {
            if (!build.stale) continue
            warnings.push(`Vulnerability server: its ${tool} database (built ${build.built_at}) is ${describeAge(build.age_seconds)} `
                + 'and past the server\'s stale age; findings newer than that build are missing')
        }
    }
    return warnings
}

/** `trivy 0.74.0 (DB 2026-10-01T19:00:16Z)`, for the summary line. */
export function describeServerScanners(answer: VulnServerAnswer): string {
    return (['trivy', 'grype'] as const).map(tool => {
        const builds = answer.databases[tool].map(it => it.built_at).join(', ')
        return `${tool} ${answer.scanners[tool].join('/') || '?'}${builds ? ` (DB built ${builds})` : ''}`
    }).join(' + ')
}
