import {mkdirSync, rmSync, statSync, writeFileSync, readdirSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHttpClient, createLimiter, fetchPackage, nullLogger, parsePurl} from '../src/index.js'
import type {ResolvedPackage} from '../src/index.js'
import {FIXTURE_CASE_FILE, type FixtureCase, type RecordedResponse} from '../src/testing/index.js'

/**
 * Records one fixture case: runs core's real `fetchPackage` live, with `fetch` wrapped so every
 * request it makes (in order) is written to `test/fixtures/cases/<case-id>/`, bodies as received.
 *
 *   npm run record-fixture-case -w @depinder/core -- <case-id> <purl> "<pattern>"
 */

const CASES_DIR = fileURLToPath(new URL('../test/fixtures/cases/', import.meta.url))
/** The response headers core's code reads; everything else is left out of `case.json`. */
const KEPT_HEADERS = ['content-type', 'retry-after', 'etag', 'last-modified']

interface Recording {
    response: RecordedResponse
    bytes: Uint8Array
}

function recordingFetch(recordings: Recording[]): typeof fetch {
    const realFetch = globalThis.fetch
    return async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const response = await realFetch(input, init)
        const bytes = new Uint8Array(await response.clone().arrayBuffer())
        const headers = Object.fromEntries(
            KEPT_HEADERS.flatMap(name => (response.headers.has(name) ? [[name, response.headers.get(name)!]] : [])),
        )
        const method = (init?.method ?? 'GET').toUpperCase()
        recordings.push({response: {method, url, status: response.status, headers}, bytes})
        return response
    }
}

/** A file name saying what the body is, e.g. `metadata.xml`, `packument.json`, `info-v1.2.0.json`. */
function bodyFileName(url: string, contentType: string): string {
    const {host, pathname} = new URL(url)
    const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const last = segments.at(-1) ?? 'index'
    if (host === 'repo1.maven.org') {
        if (pathname.endsWith('/')) return 'listing.html'
        return last === 'maven-metadata.xml' ? 'metadata.xml' : last
    }
    if (host === 'registry.npmjs.org') return 'packument.json'
    if (host === 'pypi.org') return 'project.json'
    if (host === 'crates.io') return 'crate.json'
    if (host === 'rubygems.org') return segments.at(-2) === 'versions' ? 'versions.json' : 'gem.json'
    if (host === 'repo.packagist.org') return `p2-${last}`
    if (host === 'api.deps.dev') return `depsdev-${sanitise(segments.slice(-2).join('-'))}.json`
    if (host === 'proxy.golang.org') return golangFileName(last)
    if (host === 'api.nuget.org') return nugetFileName(segments)
    return `${sanitise(last)}${extensionFor(contentType)}`
}

function golangFileName(last: string): string {
    if (last === 'list') return 'list.txt'
    if (last === '@latest') return 'latest.json'
    return `info-${sanitise(last.replace(/\.info$/, ''))}.json`
}

function nugetFileName(segments: string[]): string {
    const pageAt = segments.indexOf('page')
    if (pageAt >= 0) return `registration-page-${sanitise(segments.slice(pageAt + 1).join('-'))}`
    if (segments.at(-1) === 'index.json') return 'registration-index.json'
    return `catalog-${sanitise(segments.at(-1)!)}`
}

function sanitise(text: string): string {
    return text.replace(/[^A-Za-z0-9._~@+-]/g, '_')
}

function extensionFor(contentType: string): string {
    if (contentType.includes('json')) return '.json'
    if (contentType.includes('xml')) return '.xml'
    if (contentType.includes('html')) return '.html'
    return '.txt'
}

/** Writes the bodies (one file per distinct URL) and `case.json`; returns the case. */
function writeCase(caseDir: string, base: Omit<FixtureCase, 'responses'>, recordings: Recording[]): FixtureCase {
    rmSync(caseDir, {recursive: true, force: true})
    mkdirSync(caseDir, {recursive: true})
    const fileByUrl = new Map<string, string>()
    const taken = new Set<string>()
    const responses = recordings.map(({response, bytes}) => {
        if (bytes.length === 0) return response
        let file = fileByUrl.get(response.url)
        if (!file) {
            const contentType = response.headers['content-type'] ?? ''
            const name = response.status >= 400 ? `error-${response.status}${extensionFor(contentType)}` : bodyFileName(response.url, contentType)
            file = uniqueName(name, taken)
            fileByUrl.set(response.url, file)
            writeFileSync(join(caseDir, file), bytes)
        }
        return {...response, body: file}
    })
    const fixtureCase: FixtureCase = {...base, responses}
    writeFileSync(join(caseDir, FIXTURE_CASE_FILE), `${JSON.stringify(fixtureCase, null, 2)}\n`)
    return fixtureCase
}

function uniqueName(name: string, taken: Set<string>): string {
    let candidate = name
    for (let n = 2; taken.has(candidate) || candidate === FIXTURE_CASE_FILE; n++) candidate = name.replace(/(\.[^.]+)?$/, `-${n}$1`)
    taken.add(candidate)
    return candidate
}

function summarise(caseDir: string, fixtureCase: FixtureCase, pkg: ResolvedPackage | null): void {
    const bytes = readdirSync(caseDir).reduce((sum, file) => sum + statSync(join(caseDir, file)).size, 0)
    console.log(`${fixtureCase.expect} ${fixtureCase.purl}: ${fixtureCase.responses.length} requests, ${(bytes / 1024).toFixed(0)} KB`)
    for (const r of fixtureCase.responses) console.log(`  ${r.status} ${r.url} -> ${r.body ?? '(no body)'}`)
    if (!pkg) return
    const {versions, ...facts} = pkg
    console.log(`  latest=${pkg.latest} latestPrerelease=${pkg.latestPrerelease} registryLatest=${pkg.registryLatest}`)
    console.log(`  licenses=${JSON.stringify(facts.licenses)} homepage=${facts.homepageUrl} repo=${facts.repoUrl}`)
    console.log(`  ${versions.length} versions, ${versions.filter(v => v.yanked).length} yanked`)
}

async function main(): Promise<void> {
    const [caseId, purl, pattern] = process.argv.slice(2)
    if (!caseId || !purl || !pattern) {
        console.error('usage: record-fixture-case <case-id> <purl> "<pattern>"')
        process.exit(2)
    }
    const key = parsePurl(purl)
    const recordings: Recording[] = []
    globalThis.fetch = recordingFetch(recordings)
    // One request at a time, so the recorded order is the order fetchPackage asked in.
    const http = createHttpClient({limiter: createLimiter({concurrency: 1, minIntervalMs: 0})})
    const pkg = await fetchPackage(key, {http, log: nullLogger})

    const caseDir = join(CASES_DIR, caseId)
    const base = {purl, ecosystem: key.type, pattern, expect: pkg ? 'found' : 'not_found', recordedAt: new Date().toISOString()} as const
    summarise(caseDir, writeCase(caseDir, base, recordings), pkg)
}

await main()
