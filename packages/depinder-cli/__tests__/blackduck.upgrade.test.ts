import {upgradeGuidanceRows} from '../src/blackduck/export'
import {buildModel} from '../src/blackduck/model'
import {Vulnerability} from '../src/extension-points/vulnerability-checker'
import {advisory, dependency, ecosystem} from './fixtures/blackduck'

describe('upgrade recommendations from analysed dependencies', () => {
    it.each([
        {scenario: 'newest clean versions on current and future major lines',
            versions: ['6.10.2', '6.10.3', '6.11.0', '6.12.0', '7.0.0', '7.1.0'], short: '6.12.0', long: '7.1.0'},
        {scenario: 'stable versions preferred over newer pre-releases',
            versions: ['6.10.2', '6.10.3', '6.11.0-rc.1', '6.11.0', '7.0.0-alpha.8', '7.0.0-next.2'], short: '6.11.0', long: '6.11.0'},
        {scenario: 'pre-release fallback when no stable version is clean',
            versions: ['6.10.2', '6.11.0-rc.1'], short: '6.11.0-rc.1', long: '6.11.0-rc.1'},
        {scenario: 'lowest clean major jump when current line has no fix',
            versions: ['6.10.2', '7.0.0', '7.1.0', '8.0.0'], fix: '7.0.0', short: '7.0.0', long: '8.0.0'},
    ])('$scenario', ({versions, fix = '6.10.3', short, long}) => {
        const dep = dependency({vulnerabilities: [{...advisory, firstPatchedVersion: fix}], libraryInfo: {
            name: 'qs', licenses: [], versions: versions.map(version => ({version, timestamp: 0, latest: false})),
        }})

        const rows = upgradeGuidanceRows(buildModel('demo', [ecosystem(dep)], []).components)

        expect(rows).toEqual([{
            'Component Name': 'qs', 'Component Version Name': '6.10.2', 'Component Origin Name': 'npmjs',
            'Component Version Origin Id': 'qs/6.10.2', 'Total Known Vulnerabilities': '1',
            'Short Term Recommended Version Name': short, 'Short Term Recommended Origin Name': 'npmjs',
            'Short Term Recommended Origin Id': `qs/${short}`, 'Short Term Recommended Origin Version Name': short,
            'Short Term Critical Vulnerability': '0', 'Short Term High Vulnerability': '0',
            'Short Term Medium Vulnerability': '0', 'Short Term Low Vulnerability': '0',
            'Long Term Recommended Version Name': long, 'Long Term Recommended Origin Name': 'npmjs',
            'Long Term Recommended Origin Id': `qs/${long}`, 'Long Term Recommended Origin Version Name': long,
            'Long Term Critical Vulnerability': '0', 'Long Term High Vulnerability': '0',
            'Long Term Medium Vulnerability': '0', 'Long Term Low Vulnerability': '0',
        }])
    })

    it.each([
        {versions: ['2.12.0', '2.12.2', '2.12.5'], short: '2.12.5', long: '2.12.5'},
        {versions: ['2.12.0', '2.12.1', '2.13.0', '2.14.0', '2.15.0', '2.16.0', '3.0.0'], short: '2.16.0', long: '3.0.0'},
        {versions: ['2.12.0', '2.12.1', '2.13.0', '2.14.0'], short: '', long: ''},
    ])('honours fixes on separate release lines: $versions', ({versions, short, long}) => {
        const dep = dependency({version: '2.12.0',
            vulnerabilities: [{...advisory, firstPatchedVersion: '2.15.0', patchedVersions: ['2.15.0', '2.12.2']}],
            libraryInfo: {name: 'qs', licenses: [], versions: versions.map(version => ({version, timestamp: 0, latest: false}))},
        })

        const rows = upgradeGuidanceRows(buildModel('demo', [ecosystem(dep)], []).components)

        expect(rows).toMatchObject([{
            'Total Known Vulnerabilities': '1',
            'Short Term Recommended Version Name': short, 'Long Term Recommended Version Name': long,
        }])
    })

    it.each([
        {scenario: 'unfixable findings remain after upgrading', findings: [advisory, unfixed()], total: '2', target: '6.11.0', high: '0', low: '1'},
        {scenario: 'no recommendation when every finding lacks a fix', findings: [unfixed()], total: '1', target: '', high: '', low: ''},
    ])('$scenario', ({findings, total, target, high, low}) => {
        const dep = dependency({vulnerabilities: findings})

        const rows = upgradeGuidanceRows(buildModel('demo', [ecosystem(dep)], []).components)

        expect(rows).toMatchObject([{
            'Total Known Vulnerabilities': total,
            'Short Term Recommended Version Name': target, 'Long Term Recommended Version Name': target,
            'Short Term High Vulnerability': high, 'Short Term Low Vulnerability': low,
            'Long Term High Vulnerability': high, 'Long Term Low Vulnerability': low,
        }])
    })
})

function unfixed(): Vulnerability {
    return {...advisory, severity: 'LOW', firstPatchedVersion: undefined,
        identifiers: [{value: 'GHSA-x4vx-rjvf-j5p4', type: 'GHSA'}]}
}
