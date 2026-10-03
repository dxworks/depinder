import {parse} from 'csv-parse/sync'
import {convertDepToRow} from '../src/commands/analyse'
import {operationalRisk} from '../src/blackduck/risk'
import {fixedReportNow, parseReportNow, REPORT_NOW_ENV, reportNow} from '../src/utils/report-clock'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/library-info'

const saved = process.env[REPORT_NOW_ENV]
afterEach(() => {
    if (saved === undefined) delete process.env[REPORT_NOW_ENV]
    else process.env[REPORT_NOW_ENV] = saved
})

describe('parseReportNow', () => {
    it.each([
        ['2026-10-03', '2026-10-03T00:00:00.000Z'],
        ['2026-10-03T14:30:00Z', '2026-10-03T14:30:00.000Z'],
        ['2026-10-03T14:30:00.123+02:00', '2026-10-03T12:30:00.123Z'],
    ])('reads %s', (raw, iso) => {
        expect(parseReportNow(raw).toISOString()).toBe(iso)
    })

    it.each(['yesterday', 'Oct 3 2026', '2026-13-40', '1759500000000', ''])('refuses %j, naming the variable', raw => {
        expect(() => parseReportNow(raw)).toThrow(REPORT_NOW_ENV)
    })
})

describe('reportNow', () => {
    it('follows the real clock when nothing is fixed', () => {
        delete process.env[REPORT_NOW_ENV]
        const before = Date.now()
        const now = reportNow().getTime()
        expect(now).toBeGreaterThanOrEqual(before)
        expect(now).toBeLessThanOrEqual(Date.now())
        expect(fixedReportNow()).toBeUndefined()
    })

    it('returns the fixed date when one is set', () => {
        process.env[REPORT_NOW_ENV] = '2020-06-01'
        expect(reportNow().toISOString()).toBe('2020-06-01T00:00:00.000Z')
    })

    it('throws on a malformed fixed date rather than falling back to now', () => {
        process.env[REPORT_NOW_ENV] = 'soon'
        expect(() => reportNow()).toThrow(/not an ISO 8601 date/)
    })
})

describe('ages under a fixed report date', () => {
    it('grades Operational Risk from the fixed date, not from today', () => {
        // Released 2019-01-01 with three newer versions: LOW in 2020, HIGH by the real clock.
        process.env[REPORT_NOW_ENV] = '2020-06-01'
        expect(operationalRisk('2019-01-01', '3')).toBe('LOW')
        process.env[REPORT_NOW_ENV] = '2022-06-01'
        expect(operationalRisk('2019-01-01', '3')).toBe('MEDIUM')
    })

    it('measures Now-Used and Now-latest from the fixed date', () => {
        process.env[REPORT_NOW_ENV] = '2022-03-15T12:00:00Z'
        const project: DepinderProject = {name: 'proj', version: '1.0.0', path: '/repo', dependencies: {}}
        const dep: DepinderDependency = {
            id: 'lib@1.0.0', name: 'lib', version: '1.0.0', semver: null, requestedBy: ['proj@1.0.0'],
            libraryInfo: {
                name: 'lib', licenses: ['MIT'], versions: [
                    {version: '1.0.0', timestamp: Date.parse('2020-01-15T12:00:00Z'), latest: false},
                    {version: '2.0.0', timestamp: Date.parse('2021-03-15T12:00:00Z'), latest: true},
                ],
            } as unknown as LibraryInfo,
        }
        const [cells]: string[][] = parse(convertDepToRow(project, dep))
        expect([cells[8], cells[9]]).toEqual(['26', '12'])
    })
})
