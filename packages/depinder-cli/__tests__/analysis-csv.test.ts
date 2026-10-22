import {parse} from 'csv-parse/sync'
import {analysisCsvReports} from '../src/commands/analysis-csv'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/library-info'

/**
 * The report module, in memory: no SBOMs, scanners, cache or registries. Every expectation is a
 * parsed-back row, so a format slip (a shifted column, a lost header space) fails loudly.
 */

const dep = (overrides: Partial<DepinderDependency>): DepinderDependency => ({
    id: 'dep@1.0.0',
    name: 'dep',
    version: '1.0.0',
    requestedBy: ['proj@1.0.0'],
    ...overrides,
})

const versions = (used: string, latest: string): LibraryInfo['versions'] => [
    {version: '1.0.0', timestamp: Date.parse(used), latest: false},
    {version: '2.0.0', timestamp: Date.parse(latest), latest: true},
]

afterEach(() => vi.unstubAllEnvs())

describe('analysisCsvReports', () => {
    it('counts only strict >15-month outdated and >24-month out-of-support dependencies', () => {
        vi.stubEnv('DEPINDER_REPORT_NOW', '2024-03-15T12:00:00Z')
        const vuln = {severity: 'HIGH', description: '', permalink: 'https://example.test/1'}
        const lib = (name: string, used: string, latest: string): LibraryInfo =>
            ({name, licenses: ['MIT'], versions: versions(used, latest)} as LibraryInfo)
        const proj: DepinderProject = {
            name: 'proj', version: '1.0.0', path: '/repo',
            dependencies: {
                // 15 months used->latest and 24 latest->now: on the boundary, counted by neither >.
                directBoundary: dep({id: 'a@1.0.0', name: 'a', vulnerabilities: [vuln],
                    libraryInfo: lib('a', '2020-12-15T12:00:00Z', '2022-03-15T12:00:00Z')}),
                // Never enriched: still a direct dependency in the denominator, nothing else.
                directUnknown: dep({id: 'b@1.0.0', name: 'b'}),
                // 16 months used->latest, 34 latest->now: outdated and out of support.
                indirectOverdue: dep({id: 'c@1.0.0', name: 'c', requestedBy: ['parent@1.0.0'], vulnerabilities: [vuln],
                    libraryInfo: lib('c', '2020-01-15T12:00:00Z', '2021-05-15T12:00:00Z')}),
                indirectFresh: dep({id: 'd@1.0.0', name: 'd', requestedBy: ['parent@1.0.0'], vulnerabilities: [],
                    libraryInfo: lib('d', '2024-01-15T12:00:00Z', '2024-02-15T12:00:00Z')}),
            },
        }

        const rows: string[][] = parse(analysisCsvReports([proj])['project-stats'])
        expect(rows[1]).toEqual(['/repo', 'proj', '2', '2', '0', '0', '1', '50', '1', '1', '0', '1'])
    })

    it('groups licenses per project occurrence, in first-seen order, with the per-version fallback', () => {
        const shared = {name: 'shared', licenses: ['The Apache Software License, Version 2.0'], versions: []} as unknown as LibraryInfo
        const fallback = {name: 'fallback', licenses: [], versions: [
            {version: '1.0.0', timestamp: NaN, latest: true, licenses: ['MIT']},
        ]} as unknown as LibraryInfo
        const projA: DepinderProject = {name: 'a', version: '1.0.0', path: '/a', dependencies: {
            shared: dep({id: 's@1.0.0', name: 'shared', libraryInfo: shared}),
            unEnriched: dep({id: 'u@1.0.0', name: 'unEnriched'}),
        }}
        const projB: DepinderProject = {name: 'b', version: '1.0.0', path: '/b', dependencies: {
            sharedAgain: dep({id: 's2@1.0.0', name: 'sharedAgain', libraryInfo: shared}),
            fallback: dep({id: 'f@1.0.0', name: 'fallback', libraryInfo: fallback}),
        }}

        const rows: string[][] = parse(analysisCsvReports([projA, projB]).licenses)
        expect(rows).toEqual([
            ['License', 'Libraries', 'Library Names'],
            ['Apache-2.0', '2', 'shared, shared'],
            ['MIT', '1', 'fallback'],
        ])
    })

    it('writes an all-zero stats row and header-only libs/licenses for a project with no dependencies', () => {
        const proj: DepinderProject = {name: 'empty', version: '1.0.0', path: '/empty', dependencies: {}}
        const docs = analysisCsvReports([proj])

        expect(docs.licenses).toBe('License,Libraries,Library Names\n')
        expect(docs.libs).toBe(
            'Project Path,Project,Library,Used Version,Latest Version,Used Version Release Date,Latest Version Release Date,Latest-Used,Now-Used,Now-latest,Vulnerabilities,Vulnerability Details,DirectDependency,Type,Licenses\n')
        const rows: string[][] = parse(docs['project-stats'])
        expect(rows[1]).toEqual(['/empty', 'empty', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'])
    })
})
