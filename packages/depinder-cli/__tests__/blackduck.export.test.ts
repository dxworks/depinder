import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {writeBlackDuckExport, writeUpgradeGuidanceCsv, VulnerabilityFindingsFile} from '../src/blackduck/export'
import {COMPONENT_VERSIONS_COLUMNS, DEPENDENCIES_COLUMNS, SBOM_DEPENDENCIES_SOURCES_COLUMNS, UPGRADE_GUIDANCE_COLUMNS, VULNERABILITY_DETAILS_COLUMNS} from '../src/blackduck/columns'
import {buildModel} from '../src/blackduck/model'
import {advisory, dependency, ecosystem} from './fixtures/blackduck'

let folder: string
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-bd-')) })
afterEach(() => fs.rmSync(folder, {recursive: true, force: true}))

const text = (file: string) => fs.readFileSync(path.join(folder, file), 'utf8')
const csv = (file: string): Record<string, string>[] => parse(text(file), {columns: true})

describe('Black Duck report files', () => {
    it('exports consistent reports for shared vulnerable components, clean dependencies, and unenriched paths', () => {
        const unknown = {...advisory, severity: 'UNKNOWN', identifiers: [{value: 'GHSA-unkn-0000-0000', type: 'GHSA'}]}
        const model = buildModel('demo', [ecosystem(
            dependency({requestedBy: ['js-npm-nest@1.0.0', 'express@4.18.0'], vulnerabilities: [advisory, unknown]}),
            dependency({id: 'clean@1.0.0', name: 'clean', version: '1.0.0', requestedBy: ['express@4.18.0'], vulnerabilities: [], libraryInfo: undefined}),
        ), ecosystem(dependency({vulnerabilities: [{...advisory, identifiers: [{value: 'CVE-2022-24999', type: 'CVE'}]}]}))], [
            {name: 'qs', version: '6.10.2', purlType: 'npm', path: 'demo/-npm/qs/6.10.2',
                projectFilePath: '', projectPath: 'demo', matchType: 'Direct Dependency'},
            {name: 'unseen', version: '1.0.0', purlType: 'npm', path: 'demo/-npm/unseen/1.0.0',
                projectFilePath: '', projectPath: 'demo', matchType: 'Direct Dependency'},
        ], [{repo: 'demo', tree: 'demo/-npm', purlType: 'npm', parent: '(root)', child: 'qs/6.10.2', depth: 1}])

        const written = writeBlackDuckExport(model, folder)

        expect(written).toEqual([
            {file: '_dependencies.csv', rows: 2}, {file: '_dependencies_sources.csv', rows: 1},
            {file: '_dependency_edges.csv', rows: 1}, {file: '_component_versions.csv', rows: 2},
            {file: '_upgrade_guidance.csv', rows: 1}, {file: '_vulnerability_details.csv', rows: 2},
            {file: '_vulnerability_findings.json', rows: 1},
        ])
        expect(fs.readdirSync(folder).sort()).toEqual(written.map(it => it.file).sort())
        const headers = [
            ['_dependencies.csv', DEPENDENCIES_COLUMNS], ['_dependencies_sources.csv', SBOM_DEPENDENCIES_SOURCES_COLUMNS],
            ['_vulnerability_details.csv', VULNERABILITY_DETAILS_COLUMNS], ['_upgrade_guidance.csv', UPGRADE_GUIDANCE_COLUMNS],
            ['_component_versions.csv', COMPONENT_VERSIONS_COLUMNS],
            ['_dependency_edges.csv', ['Repo', 'Tree', 'Ecosystem', 'Parent Origin Id', 'Child Origin Id', 'Child Depth']],
        ] as const
        expect(headers.map(([file, columns]) => text(file).startsWith(`${columns.join(',')}\n`) && text(file).endsWith('\n')))
            .toEqual([true, true, true, true, true, true])
        expect(csv('_dependencies.csv')).toEqual([
            expect.objectContaining({'Component name': 'clean', 'Match type': 'Transitive', 'Total Vulnerability Count': '0',
                'Critical and High Vulnerability Count': '0', 'High Vulnerability Count': ''}),
            {
                'Component name': 'qs', 'Component version name': '6.10.2', 'Version id': '',
                'Component Version Origin Id': 'qs/6.10.2', 'License names': 'BSD 3-clause "New" or "Revised" License',
                'License families': 'PERMISSIVE', 'Match type': 'Direct,Transitive', 'Usage': 'DYNAMICALLY_LINKED',
                'Operational Risk': 'MEDIUM', 'Origin name': 'npmjs', 'License Risk': 'OK',
                'Total Vulnerability Count': '2', 'Critical and High Vulnerability Count': '1',
                'Critical Vulnerability Count': '', 'High Vulnerability Count': '1', 'Medium Vulnerability Count': '', 'Low Vulnerability Count': '',
                'Release Date': '\t2021-10-06', 'Newer Versions': '2', 'Commit Activity': '',
                'Commits in Past 12 Months': '', 'Contributors in Past 12 Months': '', 'Has License Conflicts': 'false',
                'Component Link': 'https://github.com/ljharb/qs', 'Open Hub URL': '',
            },
        ])
        expect(csv('_dependencies_sources.csv')).toMatchObject([{
            'Component name': 'qs', 'Component Version Origin Id': 'qs/6.10.2', 'Version id': '', 'Match type': 'Direct',
            'Path': 'demo/-npm/qs/6.10.2', 'ProjectFilePath': '', 'ProjectPath': 'demo',
            'VerifiedPath': '', 'VerifiedPathMethod': 'not-checked', 'Release Date': '\t2021-10-06',
            'Critical Vulnerability Count': '', 'High Vulnerability Count': '1', 'Total Vulnerability Count': '2',
        }])
        expect(csv('_vulnerability_details.csv')).toEqual([
            {
                'Component name': 'qs', 'Component version name': '6.10.2', 'Component Version Origin Id': 'qs/6.10.2',
                'Vulnerability id': 'GHSA-hrpp-h998-j3pp (CVE-2022-24999)', 'Description': 'qs prototype pollution',
                'Published on': '\t2022-11-27', 'Updated on': '', 'Base score': '9.8', 'Exploitability': '3.9', 'Impact': '5.9',
                'Vulnerability source': 'GHSA', 'Remediation status': 'New', 'URL': 'https://nvd.nist.gov/vuln/detail/CVE-2022-24999',
                'Security Risk': 'HIGH', 'Overall score': '', 'CWE Ids': '[CWE-1321]', 'Solution available': 'true',
                'Workaround available': '', 'Exploit available': '', 'CVSS Version': 'CVSS 3.x',
                'Match type': 'Direct Dependency', 'Vulnerability tags': '',
            },
            expect.objectContaining({'Vulnerability id': 'GHSA-unkn-0000-0000', 'Security Risk': 'UNKNOWN'}),
        ])
        expect(csv('_component_versions.csv')).toContainEqual({
            'Component name': 'qs', 'Component version name': '6.10.2', 'Component Version Origin Id': 'qs/6.10.2',
            'Origin name': 'npmjs', 'Release Date': '2021-10-06', 'Newer Versions': '2', 'Newer Versions (semver)': '2',
        })
        expect(csv('_upgrade_guidance.csv')).toMatchObject([{
            'Total Known Vulnerabilities': '2', 'Short Term Recommended Version Name': '6.11.0', 'Long Term Recommended Version Name': '6.11.0',
        }])
        expect(csv('_dependency_edges.csv')).toEqual([{
            'Repo': 'demo', 'Tree': 'demo/-npm', 'Ecosystem': 'npm', 'Parent Origin Id': '(root)', 'Child Origin Id': 'qs/6.10.2', 'Child Depth': '1',
        }])
        expect(JSON.parse(text('_vulnerability_findings.json'))).toMatchObject({schema: 1, components: [
            {name: 'qs', version: '6.10.2', vulnerabilities: [advisory, unknown]},
        ]})
    })

    it('replays upgrade guidance from persisted findings and an independently supplied registry list', () => {
        const finding = {...advisory, patchedVersions: ['6.10.3', '6.9.9']}
        writeBlackDuckExport(buildModel('demo', [ecosystem(dependency({vulnerabilities: [finding]}))], []), folder)
        const saved: VulnerabilityFindingsFile = JSON.parse(text('_vulnerability_findings.json'))
        const inputs = saved.components.map(({name, version, purlType, vulnerabilities}) => ({
            ...ecosystem(dependency({name, version, vulnerabilities, libraryInfo: {name, licenses: [],
                versions: ['6.11.0', '6.10.2', '6.10.3'].map(version => ({version, timestamp: 0, latest: false})),
            }})), purlType,
        }))
        const rebuilt = buildModel('demo', inputs, []).components

        writeUpgradeGuidanceCsv(rebuilt, path.join(folder, 'replayed'))

        expect(saved).toEqual({schema: 1, components: [{name: 'qs', version: '6.10.2', purlType: 'npm',
            origin: {name: 'npmjs', purlType: 'npm', versionSeparator: '/'}, originId: 'qs/6.10.2', vulnerabilities: [finding]}]})
        expect(text('replayed/_upgrade_guidance.csv')).toBe(text('_upgrade_guidance.csv'))
        expect(csv('replayed/_upgrade_guidance.csv')).toMatchObject([{
            'Short Term Recommended Version Name': '6.11.0', 'Long Term Recommended Version Name': '6.11.0',
            'Short Term High Vulnerability': '0', 'Long Term High Vulnerability': '0',
        }])
    })

    it('clean dependencies produce empty findings and upgrade reports', () => {
        const model = buildModel('demo', [ecosystem(dependency({vulnerabilities: []}))], [])

        writeBlackDuckExport(model, folder)

        expect(csv('_dependencies.csv')).toMatchObject([{'Total Vulnerability Count': '0', 'Match type': 'Direct'}])
        expect(csv('_upgrade_guidance.csv')).toEqual([])
        expect(csv('_vulnerability_details.csv')).toEqual([])
        expect(JSON.parse(text('_vulnerability_findings.json'))).toEqual({schema: 1, components: []})
    })

    it.each([
        {timestamp: Date.parse('2026-07-24T23:59:59Z'), expected: '\t2026-07-24'},
        {timestamp: Date.parse('2026-12-01T00:00:00Z'), expected: '\t2026-12-01'},
        {timestamp: undefined, expected: ''}, {timestamp: NaN, expected: ''},
    ])('publication timestamp $timestamp is exported as $expected', ({timestamp, expected}) => {
        const model = buildModel('demo', [ecosystem(dependency({vulnerabilities: [{...advisory, timestamp}]}))], [])

        writeBlackDuckExport(model, folder)

        expect(csv('_vulnerability_details.csv')).toMatchObject([{'Published on': expected}])
    })

    it.each([
        {vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N', exploitability: '3.9', impact: '1.4'},
        {vector: 'CVSS:3.0/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N', exploitability: '2.3', impact: '2.7'},
        {vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N', exploitability: '', impact: ''},
        {vector: 'AV:N/AC:L/Au:N/C:P/I:P/A:P', exploitability: '', impact: ''},
        {vector: 'CVSS:3.1/AV:N/AC:L', exploitability: '', impact: ''},
        {vector: undefined, exploitability: '', impact: ''},
    ])('vulnerability details render sub-scores for $vector', ({vector, exploitability, impact}) => {
        const model = buildModel('demo', [ecosystem(dependency({vulnerabilities: [{...advisory, cvssVector: vector}]}))], [])

        writeBlackDuckExport(model, folder)

        expect(csv('_vulnerability_details.csv')).toMatchObject([{'Exploitability': exploitability, 'Impact': impact}])
    })

    it.each([
        {identifiers: [{value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'}], id: 'GHSA-hrpp-h998-j3pp', url: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp'},
        {identifiers: [{value: 'cve-2022-24999', type: 'CVE'}], id: 'cve-2022-24999', url: 'https://nvd.nist.gov/vuln/detail/CVE-2022-24999'},
    ])('vulnerability $id links to its own catalogue', ({identifiers, id, url}) => {
        const model = buildModel('demo', [ecosystem(dependency({vulnerabilities: [{...advisory, identifiers}]}))], [])

        writeBlackDuckExport(model, folder)

        expect(csv('_vulnerability_details.csv')).toMatchObject([{'Vulnerability id': id, 'URL': url}])
    })
})
