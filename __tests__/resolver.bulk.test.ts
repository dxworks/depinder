import {assignPurls, bulkResolve, PluginProjects} from '../src/commands/analyse'
import {Cache} from '../src/cache/cache'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/registrar'
import {Plugin} from '../src/extension-points/plugin'
import {PackageRecord, ResolvedEntry} from '../src/resolver/client'
import {ResolverConfig} from '../src/resolver/config'

// The blacklist is read from `./.blacklist` at import time, so the only way to exercise the filter
// is to stand in for that file.
jest.mock('../src/utils/blacklist', () => ({blacklistedGlobs: ['@internal/*']}))

/**
 * Phase 2 of `analyse`: one question for the whole run, and an answer that lands in the local cache
 * under the keys phase 3 looks them up by. Everything this phase gets right shows up downstream as
 * a cache hit — which is exactly how the registrar stops being called — so these tests assert on
 * the cache and on what was asked for, not on the dependencies, which the phase never touches.
 */

const config: ResolverConfig = {url: 'https://resolver.example', token: 'secret', maxWaitMs: 60_000}

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

function plugin(name: string, ecosystem: string, purlType: string): Plugin {
    return {
        name,
        ecosystem,
        extractor: {files: [], createContexts: () => []},
        registrar: {retrieve: () => { throw new Error('the registrar must not be called in phase 2') }},
        checker: {getPURL: (lib, ver) => `pkg:${purlType}/${lib.replace(':', '/').replace('@', '%40')}@${ver}`},
    }
}

const maven = plugin('java', 'java', 'maven')
const sbomMaven = {...plugin('sbom-java', 'java', 'maven')}
const npm = plugin('javascript', 'npm', 'npm')

const record = (type: string, namespace: string | null, name: string): PackageRecord => ({
    type, namespace, name,
    description: 'a package', homepage_url: null, repo_url: null,
    licenses: ['Apache-2.0'],
    latest: {version: '2.0.0', released_at: '2024-01-01T00:00:00Z'},
    latest_prerelease: null,
    versions: [
        {version: '1.0.0', released_at: '2023-01-01T00:00:00Z', licenses: ['Apache-2.0'], prerelease: false, yanked: false},
        {version: '2.0.0', released_at: '2024-01-01T00:00:00Z', licenses: ['Apache-2.0'], prerelease: false, yanked: false},
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

describe('the bulk resolve phase', () => {
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
            // `java` and `sbom-java` share an ecosystem, so they share a cache key too.
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

    it('does nothing at all when every dependency is already cached', async () => {
        const cache = fakeCache()
        cache.set('npm:left-pad', {name: 'left-pad', licenses: [], versions: []})
        const projects: PluginProjects[] = [{plugin: npm, projects: [project('app', [dep('left-pad', '1.0.0')])]}]
        assignPurls(projects)
        const server = answering({})

        const outcome = await bulkResolve(config, projects, cache, {}, server.resolve)

        expect(server.resolve).not.toHaveBeenCalled()
        expect(outcome).toEqual({written: new Set(), requested: 0, resolved: 0})
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
