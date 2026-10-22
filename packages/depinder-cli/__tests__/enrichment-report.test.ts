import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {
    EnrichmentProject,
    EnrichmentReport,
    UnresolvedPackage,
    writeEnrichmentReport,
} from '../src/commands/enrichment-report'
import {DepinderDependency} from '../src/extension-points/extract'

const project = (name: string, projectPath: string, version = '1.0.0', sbomFile = '/repo/app.cdx.json'): EnrichmentProject =>
    ({name, version, path: projectPath, sbomFile})
const dep = (name: string, version = '1.0.0', purl?: string): Pick<DepinderDependency, 'name' | 'version' | 'purl'> =>
    ({name, version, purl})

const webA = project('web-a', 'web-a/package-lock.json')
const webB = project('web-b', 'web-b/package-lock.json')
const app = project('app', 'pom.xml')

describe('collecting outcomes', () => {
    /**
     * The run's four unique (ecosystem, name, version) keys, with every kind of outcome and
     * observations landing from several projects: shared@1.0.0 resolves in web-a even though it
     * failed in web-b; shared@2.0.0 fails; the maven artifact is a cached miss; the private one
     * is blacklisted.
     */
    function collected(): EnrichmentReport {
        const report = new EnrichmentReport()
        const shared1 = dep('shared', '1.0.0', 'pkg:npm/shared@1.0.0')
        report.observe('npm', webA, shared1, {status: 'resolved'})
        report.observe('npm', webB, shared1, {status: 'lookup_failed', reason: 'HTTP 404'})
        const shared2 = dep('shared', '2.0.0', 'pkg:npm/shared@2.0.0')
        report.observe('npm', webA, shared2, {status: 'lookup_failed', reason: 'HTTP 500'})
        report.observe('npm', webB, shared2, {status: 'lookup_failed', reason: 'HTTP 500'})
        report.observe('maven', app, dep('org.example:shared'), {status: 'cached_miss', reason: 'failed within 24h'})
        report.observe('npm', webB, dep('@internal/private'), {status: 'skipped'})
        return report
    }

    it('counts unique identities, success on any occurrence winning', () => {
        const {summary} = collected().snapshot('syft')

        expect(summary.totals).toEqual({detected: 4, resolved: 1, unresolved: 2, skipped: 1})
        expect(summary.ecosystems).toEqual({
            npm: {detected: 3, resolved: 1, unresolved: 1, skipped: 1},
            maven: {detected: 1, resolved: 0, unresolved: 1, skipped: 0},
        })
    })

    it('lists only unresolved identities, sorted, each with every project that carried it', () => {
        const {unresolved} = collected().snapshot('syft')

        expect(unresolved.map(it => `${it.ecosystem}:${it.name}@${it.version}`)).toEqual([
            'maven:org.example:shared@1.0.0',
            'npm:shared@2.0.0',
        ])
        const [mavenRow, npmRow] = unresolved as [UnresolvedPackage, UnresolvedPackage]
        expect(mavenRow.status).toBe('cached_miss')
        expect(mavenRow.projects).toEqual([{name: 'app', version: '1.0.0', path: 'pom.xml', sbomFile: '/repo/app.cdx.json'}])
        expect(npmRow.status).toBe('lookup_failed')
        expect(npmRow.reason).toBe('HTTP 500')
        expect(npmRow.purl).toBe('pkg:npm/shared@2.0.0')
        // Observed in web-b too, with the same failure: the ref is still recorded.
        expect(npmRow.projects).toEqual([
            {name: 'web-a', version: '1.0.0', path: 'web-a/package-lock.json', sbomFile: '/repo/app.cdx.json'},
            {name: 'web-b', version: '1.0.0', path: 'web-b/package-lock.json', sbomFile: '/repo/app.cdx.json'},
        ])
    })

    it.each([
        ['resolved then failed', (report: EnrichmentReport) => {
            report.observe('npm', webA, dep('shared', '1.0.0'), {status: 'resolved'})
            report.observe('npm', webB, dep('shared', '1.0.0'), {status: 'lookup_failed', reason: 'HTTP 404'})
        }],
        ['failed then resolved', (report: EnrichmentReport) => {
            report.observe('npm', webB, dep('shared', '1.0.0'), {status: 'lookup_failed', reason: 'HTTP 404'})
            report.observe('npm', webA, dep('shared', '1.0.0'), {status: 'resolved'})
        }],
    ])('resolves a package observed %s', (_label, record) => {
        const report = new EnrichmentReport()
        record(report)

        const {summary, unresolved} = report.snapshot('syft')
        expect(summary.totals).toEqual({detected: 1, resolved: 1, unresolved: 0, skipped: 0})
        expect(unresolved).toEqual([])
    })

    it('keeps an actual lookup failure over a cached miss, and dedupes and sorts its reasons', () => {
        const report = new EnrichmentReport()
        const shared = dep('shared', '1.0.0')
        report.observe('npm', project('app', '/b'), shared, {status: 'lookup_failed', reason: 'b error'})
        report.observe('npm', project('app', '/a'), shared, {status: 'lookup_failed', reason: 'a error'})
        report.observe('npm', project('app', '/a'), shared, {status: 'lookup_failed', reason: 'a error'})
        report.observe('npm', project('app', '/b'), shared, {status: 'cached_miss', reason: 'old miss'})

        const {summary, unresolved} = report.snapshot('syft')
        expect(summary.totals).toEqual({detected: 1, resolved: 0, unresolved: 1, skipped: 0})
        const [row] = unresolved
        expect(row.status).toBe('lookup_failed')
        expect(row.reason).toBe('a error\nb error')
        // Same name and version, different paths: both refs, sorted by path.
        expect(row.projects).toEqual([
            {name: 'app', version: '1.0.0', path: '/a', sbomFile: '/repo/app.cdx.json'},
            {name: 'app', version: '1.0.0', path: '/b', sbomFile: '/repo/app.cdx.json'},
        ])
    })

    it('counts the same name and version once per ecosystem', () => {
        const report = new EnrichmentReport()
        report.observe('npm', webA, dep('shared', '1.0.0'), {status: 'resolved'})
        report.observe('pypi', webB, dep('shared', '1.0.0'), {status: 'lookup_failed', reason: 'not found'})

        const {summary, unresolved} = report.snapshot('syft')
        expect(summary.totals).toEqual({detected: 2, resolved: 1, unresolved: 1, skipped: 0})
        expect(summary.ecosystems).toEqual({
            npm: {detected: 1, resolved: 1, unresolved: 0, skipped: 0},
            pypi: {detected: 1, resolved: 0, unresolved: 1, skipped: 0},
        })
        expect(unresolved.map(it => `${it.ecosystem}:${it.name}@${it.version}`)).toEqual(['pypi:shared@1.0.0'])
        expect(unresolved[0].reason).toBe('not found')
    })

    it('keeps same-named projects from two SBOM files as two refs of one package', () => {
        const report = new EnrichmentReport()
        const broken = dep('shared', '1.0.0')
        const reason = 'HTTP 404'
        const webAt = (sbomFile: string) => project('web', 'web/package-lock.json', '1.0.0', sbomFile)
        report.observe('npm', webAt('/repo/b.cdx.json'), broken, {status: 'lookup_failed', reason})
        report.observe('npm', webAt('/repo/a.cdx.json'), broken, {status: 'lookup_failed', reason})
        report.observe('npm', webAt('/repo/a.cdx.json'), broken, {status: 'lookup_failed', reason})

        const {summary, unresolved} = report.snapshot('syft')
        expect(summary.totals).toEqual({detected: 1, resolved: 0, unresolved: 1, skipped: 0})
        expect(unresolved).toHaveLength(1)
        expect(unresolved[0].reason).toBe(reason)
        // Sorted by the SBOM file the project came from; the repeated A registers once.
        expect(unresolved[0].projects).toEqual([
            {name: 'web', version: '1.0.0', path: 'web/package-lock.json', sbomFile: '/repo/a.cdx.json'},
            {name: 'web', version: '1.0.0', path: 'web/package-lock.json', sbomFile: '/repo/b.cdx.json'},
        ])
    })

    it('snapshots an empty report as all zeros', () => {
        const {summary, unresolved} = new EnrichmentReport().snapshot('syft')

        expect(summary.totals).toEqual({detected: 0, resolved: 0, unresolved: 0, skipped: 0})
        expect(summary.ecosystems).toEqual({})
        expect(unresolved).toEqual([])
    })
})

describe('writing the report', () => {
    let tmp: string
    let folder: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-enrich-'))
        folder = path.join(tmp, 'syft')
    })
    afterEach(() => fs.rmSync(tmp, {recursive: true, force: true}))

    it('round-trips commas, quotes and newlines through the CSV', () => {
        const report = new EnrichmentReport()
        report.observe('npm', project('web,"a"', '/repo/"q"'), dep('lib,"x"', '1.0.0', 'pkg:npm/lib@1.0.0'),
            {status: 'lookup_failed', reason: 'HTTP 500, "upstream"\nretry later'})

        const summary = writeEnrichmentReport(folder, report)

        expect(summary).toEqual(JSON.parse(fs.readFileSync(path.join(folder, 'summary.json'), 'utf8')))
        expect(summary.source).toBe('syft')
        expect(summary.schemaVersion).toBe(1)
        expect(summary.countingUnit).toBe('ecosystem+name+version')
        expect(summary.scope).toBe('dependencies parsed by selected plugins')

        const rows = parse(fs.readFileSync(path.join(folder, 'unresolved-packages.csv'), 'utf8')) as string[][]
        expect(rows).toHaveLength(2)
        expect(rows[0]).toEqual(['ecosystem', 'name', 'version', 'purl', 'projects', 'status', 'reason'])
        expect(rows[1]).toHaveLength(7)
        const [ecosystem, name, version, purl, projects, status, reason] = rows[1]
        expect([ecosystem, name, version, purl, status])
            .toEqual(['npm', 'lib,"x"', '1.0.0', 'pkg:npm/lib@1.0.0', 'lookup_failed'])
        expect(reason).toBe('HTTP 500, "upstream"\nretry later')
        expect(JSON.parse(projects)).toEqual([{name: 'web,"a"', version: '1.0.0', path: '/repo/"q"', sbomFile: '/repo/app.cdx.json'}])
    })

    it('rewrites the folder with an empty report, leaving a header-only CSV', () => {
        const report = new EnrichmentReport()
        report.observe('npm', webA, dep('broken'), {status: 'lookup_failed', reason: 'gone'})
        writeEnrichmentReport(folder, report)

        const summary = writeEnrichmentReport(folder, new EnrichmentReport())

        expect(summary.totals).toEqual({detected: 0, resolved: 0, unresolved: 0, skipped: 0})
        expect(fs.readFileSync(path.join(folder, 'unresolved-packages.csv'), 'utf8'))
            .toBe('ecosystem,name,version,purl,projects,status,reason\n')
    })
})
