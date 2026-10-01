import fs from 'fs'
import os from 'os'
import path from 'path'
import {assignPurls, bulkResolve, PluginProjects} from '../src/commands/analyse'
import {Cache} from '../src/cache/cache'
import {resetSharedCacheDb, sharedCacheDb, sqliteCacheWithCutoff} from '../src/cache/sqlite-cache'
import {freshnessCutoffMs} from '../src/cache/max-age'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/registrar'
import {Plugin} from '../src/extension-points/plugin'
import {PackageRecord, ResolvedEntry} from '../src/resolver/client'
import {ResolverConfig} from '../src/resolver/config'
import {getVulnerabilitiesFromGithub} from '../src/utils/vulnerabilities'

// The blacklist is read from `./.blacklist` at import time, so the only way to exercise the filter
// is to stand in for that file.
jest.mock('../src/utils/blacklist', () => ({blacklistedGlobs: ['@internal/*']}))
jest.mock('../src/utils/vulnerabilities', () => ({getVulnerabilitiesFromGithub: jest.fn(async () => [])}))

const advisories = getVulnerabilitiesFromGithub as jest.Mock

/**
 * Phase 2 of `analyse`: one question for the whole run, and an answer that lands in the local cache
 * under the keys phase 3 looks them up by. Everything this phase gets right shows up downstream as
 * a cache hit — which is exactly how the registrar stops being called — so these tests assert on
 * the cache and on what was asked for, not on the dependencies, which the phase never touches.
 */

const config: ResolverConfig = {url: 'https://resolver.example', token: 'secret', maxWaitMs: 60_000, chunkConcurrency: 4}

function fakeCache(): Cache & {entries: Map<string, LibraryInfo>} {
    const entries = new Map<string, LibraryInfo>()
    return {
        entries,
        get: (key: string) => entries.get(key),
        set: (key: string, value: LibraryInfo) => { entries.set(key, value) },
        has: (key: string) => entries.has(key),
        load: () => { /* nothing */ },
        flush: () => { /* nothing */ },
        write: () => { /* nothing */ },
    }
}

const dep = (name: string, version: string): DepinderDependency =>
    ({id: `${name}@${version}`, name, version, semver: null, requestedBy: []})

function project(name: string, deps: DepinderDependency[]): DepinderProject {
    return {name, version: '1.0.0', path: `/repo/${name}`, dependencies: Object.fromEntries(deps.map(it => [it.id, it]))}
}

function plugin(name: string, ecosystem: string, purlType: string, advisoryEcosystem?: string): Plugin {
    return {
        name,
        ecosystem,
        extractor: {files: [], createContexts: () => []},
        registrar: {retrieve: () => { throw new Error('the registrar must not be called in phase 2') }},
        checker: {
            githubSecurityAdvisoryEcosystem: advisoryEcosystem,
            getPURL: (lib, ver) => `pkg:${purlType}/${lib.replace(':', '/').replace('@', '%40')}@${ver}`,
        },
    }
}

const maven = plugin('java', 'java', 'maven', 'MAVEN')
const sbomMaven = {...plugin('sbom-java', 'java', 'maven', 'MAVEN')}
const npm = plugin('javascript', 'npm', 'npm', 'NPM')

const record = (type: string, namespace: string | null, name: string): PackageRecord => ({
    type, namespace, name,
    description: 'a package', homepage_url: null, repo_url: null,
    licenses: ['Apache-2.0'],
    latest: {version: '2.0.0', released_at: '2024-01-01T00:00:00Z'},
    latest_prerelease: null,
    versions: [
        ['1.0.0', Math.floor(Date.parse('2023-01-01T00:00:00Z') / 1000), 0],
        ['2.0.0', Math.floor(Date.parse('2024-01-01T00:00:00Z') / 1000), 0],
    ],
    as_of: null, source: 'test', fetched_at: '2026-09-16T10:00:00Z',
})

/** A resolver that resolves everything it is asked about, and records what that was. */
function answering(packages: {[purl: string]: PackageRecord}) {
    const asked: string[][] = []
    const resolve = jest.fn(async (_config: ResolverConfig, purls: string[]) => {
        asked.push([...purls])
        return new Map<string, ResolvedEntry>(purls.map(purl => [
            purl,
            packages[purl]
                ? {status: 'resolved' as const, package: packages[purl]}
                : {status: 'not_found' as const},
        ]))
    })
    return {asked, resolve: resolve as any}
}

describe('assignPurls', () => {
    it('names every dependency with its plugin\'s purl spelling', () => {
        const projects: PluginProjects[] = [
            {plugin: maven, projects: [project('app', [dep('com.google.guava:guava', '32.1.2-jre')])]},
            {plugin: npm, projects: [project('web', [dep('@types/node', '20.1.0')])]},
        ]

        expect(assignPurls(projects)).toBe(2)
        expect(projects[0].projects[0].dependencies['com.google.guava:guava@32.1.2-jre'].purl)
            .toBe('pkg:maven/com.google.guava/guava@32.1.2-jre')
        expect(projects[1].projects[0].dependencies['@types/node@20.1.0'].purl)
            .toBe('pkg:npm/%40types/node@20.1.0')
    })

    it('leaves a dependency with no version, and a plugin with no checker, unnamed', () => {
        const noChecker: Plugin = {...maven, checker: undefined}
        const projects: PluginProjects[] = [
            {plugin: maven, projects: [project('app', [dep('a:b', '  ')])]},
            {plugin: noChecker, projects: [project('app', [dep('c:d', '1.0.0')])]},
        ]

        expect(assignPurls(projects)).toBe(0)
        expect(projects[0].projects[0].dependencies['a:b@  '].purl).toBeUndefined()
        expect(projects[1].projects[0].dependencies['c:d@1.0.0'].purl).toBeUndefined()
    })
})

describe('assignPurls with purls from the SBOM', () => {
    it('keeps a purl the parser already set, and fills a missing one via getPURL', () => {
        // Trivy's golang purl would lowercase the module; the parser restored the case, and
        // getPURL must not undo that.
        const fromSbom = {...dep('github.com/Masterminds/semver/v3', 'v3.4.0'),
            purl: 'pkg:golang/github.com/Masterminds/semver/v3@v3.4.0'}
        const missing = dep('com.google.guava:guava', '32.1.2-jre')
        const projects: PluginProjects[] = [{plugin: sbomMaven, projects: [project('app', [fromSbom, missing])]}]

        expect(assignPurls(projects)).toBe(2)
        expect(fromSbom.purl).toBe('pkg:golang/github.com/Masterminds/semver/v3@v3.4.0')
        expect(missing.purl).toBe('pkg:maven/com.google.guava/guava@32.1.2-jre')
    })

    it('counts an SBOM purl even when the plugin has no checker to fall back on', () => {
        const noChecker: Plugin = {...maven, checker: undefined}
        const versionless = {...dep('org.apache.phoenix:phoenix-core', 'UNKNOWN'),
            purl: 'pkg:maven/org.apache.phoenix/phoenix-core'}
        const projects: PluginProjects[] = [{plugin: noChecker, projects: [project('app', [versionless])]}]

        expect(assignPurls(projects)).toBe(1)
        expect(versionless.purl).toBe('pkg:maven/org.apache.phoenix/phoenix-core')
    })
})

describe('the bulk resolve phase', () => {
    const savedToken = process.env.GH_TOKEN

    beforeEach(() => {
        advisories.mockClear()
        advisories.mockImplementation(async () => [])
        delete process.env.GH_TOKEN
    })
    afterEach(() => {
        if (savedToken === undefined) delete process.env.GH_TOKEN
        else process.env.GH_TOKEN = savedToken
    })

    it('writes what the resolver answered under the cache key phase 3 reads', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [{plugin: maven, projects: [project('app', [dep('com.google.guava:guava', '32.1.2-jre')])]}]
        assignPurls(projects)
        const server = answering({'pkg:maven/com.google.guava/guava@32.1.2-jre': record('maven', 'com.google.guava', 'guava')})

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(outcome.requested).toBe(1)
        expect(outcome.resolved).toBe(1)
        expect([...outcome.written]).toEqual(['java:com.google.guava:guava'])
        // The key `processDep` builds is `${ecosystemOf(plugin)}:${dep.name}` — a hit here is a
        // registry call that never happens.
        expect(await cache.has('java:com.google.guava:guava')).toBe(true)
        expect(cache.entries.get('java:com.google.guava:guava')?.name).toBe('com.google.guava:guava')
        expect(cache.entries.get('java:com.google.guava:guava')?.versions.map(it => it.version)).toEqual(['1.0.0', '2.0.0'])
    })

    it('asks about one purl once, however many plugins and projects found it', async () => {
        const cache = fakeCache()
        const guava = 'com.google.guava:guava'
        const projects: PluginProjects[] = [
            {plugin: maven, projects: [project('app', [dep(guava, '32.1.2-jre')]), project('lib', [dep(guava, '32.1.2-jre')])]},
            // Two plugins sharing an ecosystem share a cache key too.
            {plugin: sbomMaven, projects: [project('sbom', [dep(guava, '32.1.2-jre')])]},
        ]
        assignPurls(projects)
        const server = answering({'pkg:maven/com.google.guava/guava@32.1.2-jre': record('maven', 'com.google.guava', 'guava')})

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.resolve).toHaveBeenCalledTimes(1)
        expect(server.asked[0]).toEqual(['pkg:maven/com.google.guava/guava@32.1.2-jre'])
        expect([...outcome.written]).toEqual(['java:com.google.guava:guava'])
        expect(cache.entries.size).toBe(1)
    })

    it('asks about two versions of the same library, and writes the cache key once', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [{
            plugin: npm,
            projects: [project('app', [dep('left-pad', '1.0.0')]), project('other', [dep('left-pad', '1.3.0')])],
        }]
        assignPurls(projects)
        const server = answering({
            'pkg:npm/left-pad@1.0.0': record('npm', null, 'left-pad'),
            'pkg:npm/left-pad@1.3.0': record('npm', null, 'left-pad'),
        })

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.asked[0]).toEqual(['pkg:npm/left-pad@1.0.0', 'pkg:npm/left-pad@1.3.0'])
        expect([...outcome.written]).toEqual(['npm:left-pad'])
    })

    it('does not ask about what the local cache already holds', async () => {
        const cache = fakeCache()
        cache.set('npm:left-pad', {name: 'left-pad', licenses: [], versions: []})
        const projects: PluginProjects[] = [{
            plugin: npm,
            projects: [project('app', [dep('left-pad', '1.0.0'), dep('right-pad', '2.0.0')])],
        }]
        assignPurls(projects)
        const server = answering({'pkg:npm/right-pad@2.0.0': record('npm', null, 'right-pad')})

        await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.asked[0]).toEqual(['pkg:npm/right-pad@2.0.0'])
    })

    it('asks about everything under --refresh, cached or not', async () => {
        const cache = fakeCache()
        cache.set('npm:left-pad', {name: 'left-pad', licenses: [], versions: []})
        const projects: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('left-pad', '1.0.0')])]}]
        assignPurls(projects)
        const server = answering({'pkg:npm/left-pad@1.0.0': record('npm', null, 'left-pad')})

        const outcome = await bulkResolve(config, projects, cache, {refresh: true}, server.resolve)

        expect(server.asked[0]).toEqual(['pkg:npm/left-pad@1.0.0'])
        expect(outcome.written.has('npm:left-pad')).toBe(true)
        expect(cache.entries.get('npm:left-pad')?.description).toBe('a package')
    })

    it('leaves blacklisted and unnamed dependencies out of the question', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [{
            plugin: npm,
            projects: [project('app', [dep('@internal/secret', '1.0.0'), dep('left-pad', '1.0.0'), dep('no-version', '')])],
        }]
        assignPurls(projects)
        const server = answering({'pkg:npm/left-pad@1.0.0': record('npm', null, 'left-pad')})

        await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.asked[0]).toEqual(['pkg:npm/left-pad@1.0.0'])
    })

    it('writes nothing for pending, not_found or invalid, so they fall back to the registrar', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [{
            plugin: npm,
            projects: [project('app', [dep('pending-pkg', '1.0.0'), dep('missing-pkg', '1.0.0'), dep('bad-pkg', '1.0.0')])],
        }]
        assignPurls(projects)
        const resolve = jest.fn(async (_config: ResolverConfig, purls: string[]) => new Map<string, ResolvedEntry>([
            [purls[0], {status: 'pending'}],
            [purls[1], {status: 'not_found'}],
            [purls[2], {status: 'invalid', reason: 'unparseable purl'}],
        ])) as any

        const outcome = await bulkResolve(config, projects, cache, {}, resolve)

        expect(outcome.resolved).toBe(0)
        expect(outcome.written.size).toBe(0)
        expect(cache.entries.size).toBe(0)
    })

    it('writes a refreshing package\'s last facts, unless the run said --refresh', async () => {
        const projects = (): PluginProjects[] => {
            const p: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('old-pkg', '1.0.0')])]}]
            assignPurls(p)
            return p
        }
        const resolve = jest.fn(async (_config: ResolverConfig, purls: string[]) => new Map<string, ResolvedEntry>([
            [purls[0], {status: 'refreshing', package: record('npm', null, 'old-pkg')}],
        ])) as any

        const kept = fakeCache()
        const outcome = await bulkResolve(config, projects(), kept, {}, resolve)
        expect([...outcome.written]).toEqual(['npm:old-pkg'])
        expect(await kept.has('npm:old-pkg')).toBe(true)

        // --refresh asked for nothing older than the run: the registrar gets it instead.
        const refreshed = fakeCache()
        const refreshOutcome = await bulkResolve(config, projects(), refreshed, {refresh: true}, resolve)
        expect(refreshOutcome.written.size).toBe(0)
        expect(refreshed.entries.size).toBe(0)
    })

    it('does nothing at all when every dependency is already cached', async () => {
        const cache = fakeCache()
        cache.set('npm:left-pad', {name: 'left-pad', licenses: [], versions: []})
        const projects: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('left-pad', '1.0.0')])]}]
        assignPurls(projects)
        const server = answering({})

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.resolve).not.toHaveBeenCalled()
        expect(outcome).toEqual({written: new Set(), libs: new Map(), requested: 0, resolved: 0})
    })

    /**
     * A resolved package is a cache hit in phase 3, and a cache hit has never fetched advisories —
     * so without this the bulk phase would empty the vulnerability columns for everything the
     * resolver answered on a cold run. Parity with the registrar path, at the same cost:
     * one GraphQL call per cache key, which is what that cold run pays today.
     */
    describe('the GitHub advisory lookup', () => {
        const twoEcosystems = (): PluginProjects[] => {
            const projects: PluginProjects[] = [
                {plugin: maven, projects: [project('app', [dep('com.google.guava:guava', '32.1.2-jre')])]},
                {plugin: npm, projects: [project('web', [dep('left-pad', '1.0.0')])]},
            ]
            assignPurls(projects)
            return projects
        }
        const server = () => answering({
            'pkg:maven/com.google.guava/guava@32.1.2-jre': record('maven', 'com.google.guava', 'guava'),
            'pkg:npm/left-pad@1.0.0': record('npm', null, 'left-pad'),
        })

        it('runs once per cache key, with that plugin\'s ecosystem and the library name', async () => {
            process.env.GH_TOKEN = 'a-token'
            advisories.mockImplementation(async (_ecosystem: string, name: string) => [
                {severity: 'HIGH', description: `${name} is vulnerable`, permalink: 'https://example/1'},
            ])
            const cache = fakeCache()

            await bulkResolve(config, twoEcosystems(), cache, {}, server().resolve)

            expect(advisories).toHaveBeenCalledTimes(2)
            expect(advisories.mock.calls).toEqual(expect.arrayContaining([
                ['MAVEN', 'com.google.guava:guava'],
                ['NPM', 'left-pad'],
            ]))
            expect(cache.entries.get('java:com.google.guava:guava')?.vulnerabilities)
                .toEqual([{severity: 'HIGH', description: 'com.google.guava:guava is vulnerable', permalink: 'https://example/1'}])
            expect(cache.entries.get('npm:left-pad')?.vulnerabilities).toHaveLength(1)
        })

        it('is not called at all without a token', async () => {
            const cache = fakeCache()

            await bulkResolve(config, twoEcosystems(), cache, {}, server().resolve)

            expect(advisories).not.toHaveBeenCalled()
            expect(cache.entries.get('java:com.google.guava:guava')?.vulnerabilities).toBeUndefined()
            expect(cache.entries.size).toBe(2)
        })

        it('is not called for a plugin with no advisory ecosystem', async () => {
            process.env.GH_TOKEN = 'a-token'
            const rust = plugin('rust', 'rust', 'cargo')
            const projects: PluginProjects[] = [{plugin: rust, projects: [project('app', [dep('serde', '1.0.0')])]}]
            assignPurls(projects)
            const cache = fakeCache()

            await bulkResolve(config, projects, cache, {}, answering({'pkg:cargo/serde@1.0.0': record('cargo', null, 'serde')}).resolve)

            expect(advisories).not.toHaveBeenCalled()
            expect(cache.entries.has('rust:serde')).toBe(true)
        })

        it('runs once for a purl two plugins share, because they share the cache key', async () => {
            process.env.GH_TOKEN = 'a-token'
            const guava = 'com.google.guava:guava'
            const projects: PluginProjects[] = [
                {plugin: maven, projects: [project('app', [dep(guava, '32.1.2-jre')])]},
                {plugin: sbomMaven, projects: [project('sbom', [dep(guava, '32.1.2-jre')])]},
            ]
            assignPurls(projects)
            const cache = fakeCache()

            await bulkResolve(config, projects, cache, {}, answering({
                'pkg:maven/com.google.guava/guava@32.1.2-jre': record('maven', 'com.google.guava', 'guava'),
            }).resolve)

            expect(advisories).toHaveBeenCalledTimes(1)
        })

        it('keeps the registry data when the lookup fails', async () => {
            process.env.GH_TOKEN = 'a-token'
            advisories.mockImplementation(async () => { throw new Error('401 Bad credentials') })
            const cache = fakeCache()

            const outcome = await bulkResolve(config, twoEcosystems(), cache, {}, server().resolve)

            expect(outcome.written.size).toBe(2)
            expect(cache.entries.get('npm:left-pad')?.versions).toHaveLength(2)
            expect(cache.entries.get('npm:left-pad')?.vulnerabilities).toBeUndefined()
        })
    })

    /**
     * Phase 3 looks here before it touches the cache, so what comes back has to be the same object
     * under the same key — a `has` plus a `get` plus a `JSON.parse` of ~10 KB per dependency,
     * 15,587 times on the benchmark, to arrive at something phase 2 had in its hand.
     */
    it('hands back the library objects it wrote, under the keys it wrote them as', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [
            {plugin: maven, projects: [project('app', [dep('com.google.guava:guava', '32.1.2-jre')])]},
            {plugin: npm, projects: [project('web', [dep('left-pad', '1.0.0')])]},
        ]
        assignPurls(projects)
        const server = answering({
            'pkg:maven/com.google.guava/guava@32.1.2-jre': record('maven', 'com.google.guava', 'guava'),
            'pkg:npm/left-pad@1.0.0': record('npm', null, 'left-pad'),
        })

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect([...outcome.libs.keys()].sort()).toEqual([...outcome.written].sort())
        expect(outcome.libs.get('npm:left-pad')?.versions.map(it => it.version)).toEqual(['1.0.0', '2.0.0'])
        // The same object, not a copy of it: the cached row is the durable copy, this is the one
        // phase 3 hands to every dependency of that library.
        expect(outcome.libs.get('java:com.google.guava:guava')).toBe(cache.entries.get('java:com.google.guava:guava'))
        expect(outcome.libs.get('npm:left-pad')).toBe(cache.entries.get('npm:left-pad'))
    })

    it('hands back nothing when nothing resolved', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('missing-pkg', '1.0.0')])]}]
        assignPurls(projects)

        const outcome = await bulkResolve(config, projects, cache, {}, answering({}).resolve)

        expect(outcome.libs.size).toBe(0)
    })

    it('survives a resolver that answered nothing, leaving the cache untouched', async () => {
        const cache = fakeCache()
        const projects: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('left-pad', '1.0.0')])]}]
        assignPurls(projects)
        const silent = jest.fn(async () => new Map<string, ResolvedEntry>()) as any

        const outcome = await bulkResolve(config, projects, cache, {}, silent)

        expect(outcome.requested).toBe(1)
        expect(outcome.resolved).toBe(0)
        expect(cache.entries.size).toBe(0)
    })
})

/**
 * The bulk phase asks about expired entries too, not only missing ones: an entry past the cache
 * max age reads as absent through the analyse cache, so its purl lands in the ask list, and the
 * answer rewrites the row with a new age.
 */
describe('the bulk resolve phase with a cache max age', () => {
    let tmp: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-bulk-age-'))
        process.env.DEPINDER_CACHE_DB = path.join(tmp, 'depinder.sqlite')
        resetSharedCacheDb()
    })
    afterEach(() => {
        resetSharedCacheDb()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    function cachedAgo(key: string, ageMs: number) {
        const db = sharedCacheDb()
        db.setLib(key, {name: key, description: 'cached', licenses: [], versions: []})
        ;(db as any).db.prepare('UPDATE libs SET updated_at = ? WHERE key = ?').run(Date.now() - ageMs, key)
    }

    it('asks about an expired entry, skips a fresh one, and rewrites the expired row', async () => {
        cachedAgo('npm:left-pad', 2 * 86_400_000)
        cachedAgo('npm:right-pad', 60_000)
        const runStart = Date.now()
        const cache = sqliteCacheWithCutoff(freshnessCutoffMs(86_400, runStart))
        const projects: PluginProjects[] = [{
            plugin: npm,
            projects: [project('app', [dep('left-pad', '1.0.0'), dep('right-pad', '2.0.0')])],
        }]
        assignPurls(projects)
        const server = answering({'pkg:npm/left-pad@1.0.0': record('npm', null, 'left-pad')})

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.asked[0]).toEqual(['pkg:npm/left-pad@1.0.0'])
        expect(outcome.written.has('npm:left-pad')).toBe(true)
        expect(sharedCacheDb().getLib('npm:left-pad')?.description).toBe('a package')
        expect(sharedCacheDb().libUpdatedAt('npm:left-pad')).toBeGreaterThanOrEqual(runStart)
        expect(sharedCacheDb().getLib('npm:right-pad')?.description).toBe('cached')
    })

    it('leaves an expired row untouched when the resolver cannot answer, for the registrar to try', async () => {
        cachedAgo('npm:left-pad', 2 * 86_400_000)
        const before = sharedCacheDb().libUpdatedAt('npm:left-pad')
        const cache = sqliteCacheWithCutoff(freshnessCutoffMs(86_400))
        const projects: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('left-pad', '1.0.0')])]}]
        assignPurls(projects)
        const server = answering({})

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.asked[0]).toEqual(['pkg:npm/left-pad@1.0.0'])
        expect(outcome.written.size).toBe(0)
        expect(sharedCacheDb().libUpdatedAt('npm:left-pad')).toBe(before)
        expect(await cache.has('npm:left-pad')).toBe(false)
    })
})
