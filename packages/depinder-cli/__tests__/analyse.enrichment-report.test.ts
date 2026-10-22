import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {CacheSession, runAnalysis} from '../src/commands/analyse'
import {clearSbomCache, deferSbomFindings, sbomPluginsForPurlTypes} from '../src/plugins/sbom'
import {clearLocalScanCache} from '../src/plugins/sbom/local-scan'
import {resetBulkResolve} from '../src/resolver/bulk-memory'
import {resetSharedCacheDb, sqliteCacheWithCutoff} from '../src/cache/sqlite-cache'
import {missCache, MISS_TTL_HOURS} from '../src/cache/misses'
import {RegistryFallback} from '../src/fallback/registry-fallback'
import {LibraryInfo} from '../src/extension-points/library-info'
import {blacklistedGlobs} from '../src/utils/blacklist'

/**
 * A Trivy-shaped BOM: a root application node whose children are application nodes named after
 * their lockfile, their direct dependencies being the project's direct libraries. The parser
 * makes one project per lockfile node.
 */
function trivyBom(projects: {name: string, libraries: string[]}[], libraries: object[], repoName = 'test-app'): object {
    const nodes = projects.map(({name}) => ({
        'bom-ref': `app:${name}`,
        type: 'application',
        name: `${name}/package-lock.json`,
        version: '1.0.0',
        properties: [
            {name: 'trivy:pkg:class', value: 'lang-pkgs'},
            {name: 'trivy:class', value: 'lang-pkgs'},
        ],
    }))
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: {component: {'bom-ref': 'root-app', type: 'application', name: repoName, version: '1.0.0'}},
        components: [
            {'bom-ref': 'root-app', type: 'application', name: repoName, version: '1.0.0'},
            ...nodes,
            ...libraries,
        ],
        dependencies: [
            {ref: 'root-app', dependsOn: projects.map(({name}) => `app:${name}`)},
            ...projects.map(({name, libraries: refs}) => ({ref: `app:${name}`, dependsOn: refs})),
        ],
    }
}

const libraryComponent = (ref: string, name: string, licenses?: string[]) => ({
    'bom-ref': ref,
    type: 'library',
    name,
    version: '1.0.0',
    purl: `pkg:npm/${name}@1.0.0`,
    ...(licenses ? {licenses: licenses.map(it => ({license: {id: it}}))} : {}),
})

/**
 * web-a asks about every library; web-b repeats three of them. broken-lib arrives carrying an SBOM
 * license: parse data must never count as enrichment.
 */
function fullBom(): object {
    return trivyBom(
        [
            {name: 'web-a', libraries: ['lib:cached', 'lib:fetched', 'lib:broken', 'lib:miss', 'lib:private']},
            {name: 'web-b', libraries: ['lib:cached', 'lib:broken', 'lib:private']},
        ],
        [
            libraryComponent('lib:cached', 'cached-lib'),
            libraryComponent('lib:fetched', 'fetched-lib'),
            libraryComponent('lib:broken', 'broken-lib', ['MIT']),
            libraryComponent('lib:miss', 'known-miss'),
            libraryComponent('lib:private', 'private-lib'),
        ],
    )
}

function cachedOnlyBom(): object {
    return trivyBom(
        [{name: 'only', libraries: ['lib:cached']}],
        [libraryComponent('lib:cached', 'cached-lib')],
    )
}

const lib = (name: string): LibraryInfo => ({name, licenses: [], versions: []})

const readSummary = (folder: string) =>
    JSON.parse(fs.readFileSync(path.join(folder, 'summary.json'), 'utf8'))
const readUnresolved = (folder: string): string[][] =>
    parse(fs.readFileSync(path.join(folder, 'unresolved-packages.csv'), 'utf8'))

describe('per-source metadata completeness report', () => {
    let tmp: string
    let syftFolder: string
    let trivyFolder: string
    let bomFile: string
    const originalBlacklist = [...blacklistedGlobs]

    const session = (): CacheSession => ({cache: sqliteCacheWithCutoff(undefined), misses: missCache})
    const plugins = () => sbomPluginsForPurlTypes(['npm'])

    beforeEach(() => {
        blacklistedGlobs.splice(0, blacklistedGlobs.length, 'private-*')
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-enrich-run-'))
        process.env.DEPINDER_CACHE_DB = path.join(tmp, 'cache', 'depinder.sqlite')
        syftFolder = path.join(tmp, 'results', 'syft')
        trivyFolder = path.join(tmp, 'results', 'trivy')
        bomFile = path.join(tmp, 'app.cdx.json')
        fs.writeFileSync(bomFile, JSON.stringify(fullBom()))
        deferSbomFindings(true)
        resetSharedCacheDb()
        resetBulkResolve()
        clearSbomCache()
        clearLocalScanCache()
    })

    afterEach(() => {
        blacklistedGlobs.splice(0, blacklistedGlobs.length, ...originalBlacklist)
        deferSbomFindings(false)
        resetSharedCacheDb()
        resetBulkResolve()
        clearSbomCache()
        clearLocalScanCache()
        delete process.env.DEPINDER_CACHE_DB
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    /** Every name succeeds but broken-lib, whose error is the reason the CSV must carry. */
    const firstRunRegistries = (): RegistryFallback => ({
        lookup: async ({name}) => {
            if (name === 'fetched-lib') return lib(name)
            throw new Error('HTTP 500, "upstream"\nretry later')
        },
        packagesAtOnce: () => 8,
    })

    const everythingAnswers = (): RegistryFallback => ({
        lookup: async ({name}) => lib(name),
        packagesAtOnce: () => 8,
    })

    it('writes summary.json and unresolved-packages.csv next to the source\'s other output, skipping blacklisted packages', async () => {
        session().cache.set('npm:cached-lib', lib('cached-lib'))
        missCache.set('npm:known-miss')

        const registries = firstRunRegistries()
        const lookup = vi.spyOn(registries, 'lookup')
        await runAnalysis([bomFile], plugins(), syftFolder,
            {results: 'results', refresh: false}, session(), undefined, undefined, registries)

        expect(lookup).toHaveBeenCalledWith({type: 'npm', name: 'fetched-lib'})
        expect(lookup).toHaveBeenCalledWith({type: 'npm', name: 'broken-lib'})
        expect(lookup).not.toHaveBeenCalledWith({type: 'npm', name: 'private-lib'})

        const summary = readSummary(syftFolder)
        expect(summary.source).toBe('syft')
        expect(summary.totals).toEqual({detected: 5, resolved: 2, unresolved: 2, skipped: 1})
        expect(summary.ecosystems.npm).toEqual({detected: 5, resolved: 2, unresolved: 2, skipped: 1})

        const rows = readUnresolved(syftFolder)
        expect(rows[0]).toEqual(['ecosystem', 'name', 'version', 'purl', 'projects', 'status', 'reason'])
        expect(rows).toHaveLength(3)

        const [eco1, name1, version1, purl1, projects1, status1, reason1] = rows[1]
        expect([eco1, name1, version1]).toEqual(['npm', 'broken-lib', '1.0.0'])
        expect(purl1).toBeTruthy()
        expect(status1).toBe('lookup_failed')
        // The actual error, not the cached miss web-b saw for the same library.
        expect(reason1).toBe('HTTP 500, "upstream"\nretry later')
        expect(JSON.parse(projects1)).toEqual([
            {name: 'web-a', version: '1.0.0', path: 'web-a/package-lock.json', sbomFile: bomFile},
            {name: 'web-b', version: '1.0.0', path: 'web-b/package-lock.json', sbomFile: bomFile},
        ])

        const [eco2, name2, version2, purl2, projects2, status2, reason2] = rows[2]
        expect([eco2, name2, version2]).toEqual(['npm', 'known-miss', '1.0.0'])
        expect(purl2).toBeTruthy()
        expect(status2).toBe('cached_miss')
        expect(reason2).toBe(`Metadata lookup failed within ${MISS_TTL_HOURS}h; original reason is not stored (--refresh to retry)`)
        expect(JSON.parse(projects2)).toEqual([
            {name: 'web-a', version: '1.0.0', path: 'web-a/package-lock.json', sbomFile: bomFile},
        ])
    })

    it('keeps every source\'s report to the packages its own SBOMs detected', async () => {
        session().cache.set('npm:cached-lib', lib('cached-lib'))
        missCache.set('npm:known-miss')
        await runAnalysis([bomFile], plugins(), syftFolder,
            {results: 'results', refresh: false}, session(), undefined, undefined, firstRunRegistries())

        const secondBomFile = path.join(tmp, 'second.cdx.json')
        fs.writeFileSync(secondBomFile, JSON.stringify(cachedOnlyBom()))
        await runAnalysis([secondBomFile], plugins(), trivyFolder,
            {results: 'results', refresh: false}, session(), undefined, undefined, everythingAnswers())

        expect(readSummary(trivyFolder).totals).toEqual({detected: 1, resolved: 1, unresolved: 0, skipped: 0})
        expect(readUnresolved(trivyFolder)).toHaveLength(1)
        expect(readSummary(syftFolder).totals).toEqual({detected: 5, resolved: 2, unresolved: 2, skipped: 1})
    })

    it('rewrites the report when --refresh recovers the failed lookups', async () => {
        session().cache.set('npm:cached-lib', lib('cached-lib'))
        missCache.set('npm:known-miss')
        await runAnalysis([bomFile], plugins(), syftFolder,
            {results: 'results', refresh: false}, session(), undefined, undefined, firstRunRegistries())

        await runAnalysis([bomFile], plugins(), syftFolder,
            {results: 'results', refresh: true}, session(), undefined, undefined, everythingAnswers())

        expect(readSummary(syftFolder).totals).toEqual({detected: 5, resolved: 4, unresolved: 0, skipped: 1})
        expect(readUnresolved(syftFolder)).toHaveLength(1)
    })

    it('tells same-named projects from different repos apart by the SBOM file they came from', async () => {
        // Two repos, one identically nested `web` project each, the same broken library: one
        // unresolved package, but both originating SBOMs on its ref list.
        const fileA = path.join(tmp, 'repo-a.cdx.json')
        const fileB = path.join(tmp, 'repo-b.cdx.json')
        fs.writeFileSync(fileA, JSON.stringify(trivyBom(
            [{name: 'web', libraries: ['lib:broken']}],
            [libraryComponent('lib:broken', 'broken-lib')],
            'repo-a',
        )))
        fs.writeFileSync(fileB, JSON.stringify(trivyBom(
            [{name: 'web', libraries: ['lib:broken']}],
            [libraryComponent('lib:broken', 'broken-lib')],
            'repo-b',
        )))

        await runAnalysis([fileA, fileB, fileA], plugins(), syftFolder,
            {results: 'results', refresh: false}, session(), undefined, undefined, firstRunRegistries())

        expect(readSummary(syftFolder).totals).toEqual({detected: 1, resolved: 0, unresolved: 1, skipped: 0})
        const rows = readUnresolved(syftFolder)
        expect(rows).toHaveLength(2)
        const [ecosystem, name, version, , projectsJson, status, reason] = rows[1]
        expect([ecosystem, name, version]).toEqual(['npm', 'broken-lib', '1.0.0'])
        expect(status).toBe('lookup_failed')
        expect(reason).toBe('HTTP 500, "upstream"\nretry later')
        expect(JSON.parse(projectsJson)).toEqual([
            {name: 'web', version: '1.0.0', path: 'web/package-lock.json', sbomFile: fileA},
            {name: 'web', version: '1.0.0', path: 'web/package-lock.json', sbomFile: fileB},
        ])
    })
})
