import {parse} from 'csv-parse/sync'
import {analysisCsvReports} from '../src/commands/analysis-csv'
import {operationalRisk} from '../src/blackduck/risk'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/library-info'

describe('ages under an injected report date', () => {
    it('grades Operational Risk from the injected date', () => {
        // Released 2019-01-01 with three newer versions: LOW in 2020, HIGH by the real clock.
        expect(operationalRisk('2019-01-01', '3', new Date('2020-06-01'))).toBe('LOW')
        expect(operationalRisk('2019-01-01', '3', new Date('2022-06-01'))).toBe('MEDIUM')
    })

    it('measures Now-Used and Now-latest from the injected date', () => {
        const project: DepinderProject = {name: 'proj', version: '1.0.0', path: '/repo', dependencies: {}}
        const dep: DepinderDependency = {
            id: 'lib@1.0.0', name: 'lib', version: '1.0.0', requestedBy: ['proj@1.0.0'],
            libraryInfo: {
                name: 'lib', licenses: ['MIT'], versions: [
                    {version: '1.0.0', timestamp: Date.parse('2020-01-15T12:00:00Z'), latest: false},
                    {version: '2.0.0', timestamp: Date.parse('2021-03-15T12:00:00Z'), latest: true},
                ],
            } as unknown as LibraryInfo,
        }
        const rows: string[][] = parse(analysisCsvReports([{...project, dependencies: {[dep.id]: dep}}], 'npm', new Date('2022-03-15T12:00:00Z')).libs)
        expect([rows[1][8], rows[1][9]]).toEqual(['26', '12'])
    })
})
