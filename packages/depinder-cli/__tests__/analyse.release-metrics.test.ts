import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {createAnalyseCommand} from '../src/commands/analyse'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {missCache} from '../src/cache/misses'
import {clearSbomCache, deferSbomFindings} from '../src/plugins/sbom'
import {clearSbomDescriptions} from '../src/plugins/sbom/describe'
import {clearLocalScanCache} from '../src/plugins/sbom/local-scan'
import {resetBulkResolve} from '../src/resolver/bulk-memory'
import {resetVulnSources} from '../src/vuln-sources/selection'
import {LibraryInfo} from '../src/extension-points/library-info'
import {log} from '../src/utils/logging'

const version = (name: string, date: string | undefined, extra = {}) => ({
    version: name, timestamp: date ? Date.parse(date) : NaN, latest: false, ...extra,
})

const originalHeaders = [
    'Component name', 'Component version name', 'Version id', 'Component Version Origin Id',
    'License names', 'License families', 'Match type', 'Usage', 'Operational Risk', 'Origin name',
    'License Risk', 'Total Vulnerability Count', 'Critical and High Vulnerability Count',
    'Critical Vulnerability Count', 'High Vulnerability Count', 'Medium Vulnerability Count',
    'Low Vulnerability Count', 'Release Date', 'Newer Versions', 'Commit Activity',
    'Commits in Past 12 Months', 'Contributors in Past 12 Months', 'Has License Conflicts',
    'Component Link', 'Open Hub URL',
]
const releaseHeaders = ['Report Date', 'Latest Version', 'Latest Version Release Date',
    'Most Recent Release Version', 'Most Recent Release Date', 'Upgrade Lag (months)', 'Months Since Last Release']

describe.each(['trivy', 'syft'])('%s release measurements', producer => {
    let tmp: string
    let reportDate: Date | undefined
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-release-'))
        reportDate = new Date('2024-03-15')
        vi.stubEnv('DEPINDER_CACHE_DB', path.join(tmp, 'cache.sqlite'))
        vi.stubEnv('TRIVY_BIN', path.join(tmp, 'missing-trivy'))
        vi.stubEnv('GRYPE_BIN', path.join(tmp, 'missing-grype'))
        resetSharedCacheDb(); resetBulkResolve(); clearSbomCache(); clearSbomDescriptions(); clearLocalScanCache(); resetVulnSources()
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        deferSbomFindings(false)
        resetSharedCacheDb(); resetBulkResolve(); clearSbomCache(); clearSbomDescriptions(); clearLocalScanCache(); resetVulnSources()
        vi.unstubAllEnvs()
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    async function analyseSbom(components: Record<string, string>[], dependencies: {ref: string, dependsOn: string[]}[]) {
        const input = path.join(tmp, 'input')
        const output = path.join(tmp, 'results')
        fs.mkdirSync(input)
        fs.writeFileSync(path.join(input, 'app.cdx.json'), JSON.stringify({
            bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
            metadata: {tools: {components: [{name: producer, version: '1'}]}, component: {'bom-ref': 'root', type: 'application', name: 'app', version: '1.0.0'}},
            components, dependencies,
        }))
        await createAnalyseCommand(reportDate).parseAsync([input, '-r', output, '--no-resolver', '--vuln-source', 'trivy'], {from: 'user'})
        return (file: string) => parse(fs.readFileSync(path.join(output, producer, file), 'utf8'), {columns: true}) as Record<string, string>[]
    }

    async function analyse(libraries: Record<string, LibraryInfo['versions']>, indirect: string[] = [], unresolved: string[] = []) {
        for (const [name, versions] of Object.entries(libraries)) {
            if (unresolved.includes(name)) missCache.set(`npm:${name}`)
            else sharedCacheDb().setLib(`npm:${name}`, {name, licenses: [], versions})
        }
        const components = Object.keys(libraries).map(name => ({'bom-ref': name, type: 'library', name, version: '1.0.0', purl: `pkg:npm/${name}@1.0.0`}))
        const read = await analyseSbom(components, [
            {ref: 'root', dependsOn: Object.keys(libraries).filter(name => !indirect.includes(name))},
            {ref: 'parent', dependsOn: indirect},
        ])
        return {rows: read('_dependencies.csv'), sources: read('_dependencies_sources.csv'), stats: read('sbom-npm-project-stats.csv')}
    }

    it('distinguishes highest version from a newer maintenance release and preserves legacy risk', async () => {
        const {rows, sources} = await analyse({maintenance: [
            version('1.0.0', '2024-02-15'), version('2.0.0', '2021-01-15', {latest: true}),
            version('3.0.0-beta', '2024-03-01'), version('4.0.0', '2024-01-01', {yanked: true}),
            version('5.0.0-beta', '2024-03-10'),
        ]})
        expect(Object.keys(rows[0])).toEqual([...originalHeaders, ...releaseHeaders])
        expect(rows[0]).toMatchObject({
            'Report Date': '\t2024-03-15', 'Latest Version': '2.0.0', 'Latest Version Release Date': '\t2021-01-15',
            'Most Recent Release Version': '1.0.0', 'Most Recent Release Date': '\t2024-02-15',
            'Upgrade Lag (months)': '0', 'Months Since Last Release': '1', 'Operational Risk': 'LOW',
        })
        expect(sources[0]['Operational Risk']).toBe('LOW')
    })

    it('selects registry releases without a report-date cutoff', async () => {
        const {rows} = await analyse({current: [
            version('1.0.0', '2024-02-15'), version('5.0.0', '2024-03-16', {latest: true}),
        ]})

        expect(rows[0]).toMatchObject({
            'Report Date': '\t2024-03-15', 'Latest Version': '5.0.0',
            'Latest Version Release Date': '\t2024-03-16', 'Most Recent Release Version': '5.0.0',
            'Most Recent Release Date': '\t2024-03-16', 'Upgrade Lag (months)': '1',
            'Months Since Last Release': '0',
        })
    })

    it('selects a later maintenance release published on the same day as a higher version', async () => {
        const {rows} = await analyse({maintenance: [
            version('1.0.0', '2024-03-01T18:00:00Z'),
            version('2.0.0', '2024-03-01T09:00:00Z'),
        ]})

        expect(rows[0]).toMatchObject({
            'Latest Version': '2.0.0', 'Most Recent Release Version': '1.0.0',
            'Most Recent Release Date': '\t2024-03-01',
        })
    })

    it('keeps independently known fields when release dates or metadata are missing', async () => {
        const {rows} = await analyse({
            partial: [version('1.0.0', '2020-01-15'), version('2.0.0', undefined)],
            missingdate: [version('1.0.0', undefined), version('2.0.0', '2024-02-14')],
            absent: [],
            sole: [version('1.0.0', undefined)],
            unavailable: [version('1.0.0', '2023-01-15', {yanked: true}), version('2.0.0', '2024-01-15', {yanked: true})],
        }, [], ['absent'])
        expect(rows.find(row => row['Component name'] === 'partial')).toMatchObject({
            'Latest Version': '2.0.0', 'Latest Version Release Date': '', 'Most Recent Release Version': '',
            'Most Recent Release Date': '', 'Upgrade Lag (months)': '', 'Months Since Last Release': '',
        })
        expect(rows.find(row => row['Component name'] === 'missingdate')).toMatchObject({
            'Release Date': '', 'Latest Version': '2.0.0', 'Latest Version Release Date': '\t2024-02-14',
            'Most Recent Release Version': '', 'Upgrade Lag (months)': '', 'Months Since Last Release': '',
        })
        expect(rows.find(row => row['Component name'] === 'absent')).toMatchObject({
            'Release Date': '', 'Latest Version': '', 'Most Recent Release Version': '', 'Upgrade Lag (months)': '', 'Months Since Last Release': '',
        })
        expect(rows.find(row => row['Component name'] === 'unavailable')).toMatchObject({
            'Release Date': '\t2023-01-15', 'Latest Version': '', 'Most Recent Release Version': '', 'Upgrade Lag (months)': '', 'Months Since Last Release': '',
        })
        expect(rows.find(row => row['Component name'] === 'sole')).toMatchObject({
            'Latest Version': '1.0.0', 'Most Recent Release Version': '1.0.0',
            'Most Recent Release Date': '', 'Upgrade Lag (months)': '', 'Months Since Last Release': '',
        })
    })

    it('counts strict thresholds for direct and indirect dependencies', async () => {
        const {rows, stats} = await analyse({
            parent: [version('1.0.0', '2024-03-15')],
            boundary: [version('1.0.0', '2020-12-15'), version('2.0.0', '2022-03-15')],
            overdue: [version('1.0.0', '2020-10-15'), version('2.0.0', '2022-02-15')],
            indirectboundary: [version('1.0.0', '2020-12-15'), version('2.0.0', '2022-03-15')],
            directoverdue: [version('1.0.0', '2020-10-15'), version('2.0.0', '2022-02-15')],
            unknown: [],
        }, ['overdue', 'indirectboundary'])
        expect(rows.find(row => row['Component name'] === 'boundary')).toMatchObject({'Upgrade Lag (months)': '15', 'Months Since Last Release': '24'})
        expect(rows.find(row => row['Component name'] === 'overdue')).toMatchObject({'Upgrade Lag (months)': '16', 'Months Since Last Release': '25'})
        expect(rows.find(row => row['Component name'] === 'indirectboundary')).toMatchObject({'Upgrade Lag (months)': '15', 'Months Since Last Release': '24'})
        expect(rows.find(row => row['Component name'] === 'directoverdue')).toMatchObject({'Upgrade Lag (months)': '16', 'Months Since Last Release': '25'})
        expect(stats[0]).toMatchObject({'Direct Deps': '4', 'Indirect Deps': '2', 'Direct Outdated Deps': '1',
            'Indirect Outdated Deps': '1', ' Direct No Recent Releases': '1', ' Indirect No Recent Releases': '1'})
    })

    it('keeps the analysis date when the clock crosses midnight before export', async () => {
        reportDate = undefined
        vi.stubEnv('DEPINDER_REPORT_NOW', '2000-01-01')
        vi.useFakeTimers({toFake: ['Date']})
        vi.setSystemTime(new Date('2024-03-14T23:59:59Z'))
        vi.spyOn(log, 'info').mockImplementation(((message: string) => {
            if (message.startsWith('Results are written to ')) vi.setSystemTime(new Date('2024-03-15T00:00:01Z'))
            return log
        }) as typeof log.info)

        const {rows, stats} = await analyse({old: [version('1.0.0', '2022-02-15')]})

        expect(rows[0]).toMatchObject({'Report Date': '\t2024-03-14', 'Months Since Last Release': '24'})
        expect(stats[0][' Direct No Recent Releases']).toBe('0')
    })

    it('calculates upgrade lag independently of the report date', async () => {
        const {rows} = await analyse({preview: [
            version('1.0.0', '2024-04-15', {yanked: true}), version('2.0.0-beta', '2023-01-15'),
        ]})
        expect(rows[0]).toMatchObject({
            'Release Date': '\t2024-04-15', 'Latest Version': '2.0.0-beta',
            'Most Recent Release Version': '2.0.0-beta', 'Upgrade Lag (months)': '0', 'Months Since Last Release': '14',
        })
    })

    it('excludes development branches and preserves a withdrawn installed release', async () => {
        sharedCacheDb().setLib('php:vendor/package', {name: 'vendor/package', licenses: [], versions: [
            version('1.0.0', '2023-01-15', {yanked: true}), version('2.0.0-beta', '2024-02-16'),
            version('dev-main', '2024-03-14'), version('3.x-dev', '2024-03-14'),
        ]})
        const read = await analyseSbom(
            [{'bom-ref': 'pkg', type: 'library', name: 'vendor/package', version: '1.0.0', purl: 'pkg:composer/vendor/package@1.0.0'}],
            [{ref: 'root', dependsOn: ['pkg']}],
        )
        const rows = read('_dependencies.csv')
        expect(rows[0]).toMatchObject({
            'Release Date': '\t2023-01-15', 'Latest Version': '2.0.0-beta',
            'Most Recent Release Version': '2.0.0-beta', 'Most Recent Release Date': '\t2024-02-16',
            'Upgrade Lag (months)': '13', 'Months Since Last Release': '0',
        })
    })
})
