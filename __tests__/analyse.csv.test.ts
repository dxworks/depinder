import {parse} from 'csv-parse/sync'
import {convertDepToRow, csvRow} from '../src/commands/analyse'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/registrar'

/**
 * Rows were built by raw interpolation, with only the vuln-details and licence cells quoted. Maven
 * range strings such as `[4.1,4.2000)` appear as versions in real SBOM data, and an unquoted one
 * splits into two cells — shifting every later column of that row. Parsing the output back with a
 * real CSV reader is the check that matters, so these tests do that rather than match strings.
 */

const project: DepinderProject = {name: 'proj', version: '1.0.0', path: '/repo', dependencies: {}}

function dependency(overrides: Partial<DepinderDependency> = {}): DepinderDependency {
    return {
        id: 'lib@1.0.0',
        name: 'lib',
        version: '1.0.0',
        semver: null,
        requestedBy: ['proj@1.0.0'],
        libraryInfo: {name: 'lib', versions: [], licenses: ['MIT']} as unknown as LibraryInfo,
        ...overrides,
    }
}

const COLUMNS = 15

function cellsOf(dep: DepinderDependency): string[] {
    const rows: string[][] = parse(convertDepToRow(project, dep), {relaxColumnCount: false})
    return rows[0]
}

describe('csvRow', () => {
    it('quotes a cell containing a comma', () => {
        expect(csvRow(['a', 'b,c', 'd'])).toBe('a,"b,c",d')
    })

    it('doubles embedded quotes', () => {
        expect(csvRow(['say "hi"'])).toBe('"say ""hi"""')
    })

    it('quotes a cell containing a newline', () => {
        expect(csvRow(['line1\nline2'])).toBe('"line1\nline2"')
    })

    it('writes an empty cell for undefined rather than the string undefined', () => {
        expect(csvRow(['a', undefined, 'b'])).toBe('a,,b')
    })

    it('leaves an ordinary cell unquoted', () => {
        expect(csvRow(['a', 1, true])).toBe('a,1,true')
    })
})

describe('convertDepToRow', () => {
    it('keeps a comma-containing version in one cell', () => {
        // A Maven range string, as seen in real SBOM data.
        const cells = cellsOf(dependency({version: '[4.1,4.2000)'}))
        expect(cells).toHaveLength(COLUMNS)
        expect(cells[3]).toBe('[4.1,4.2000)')
    })

    it('keeps a comma-containing library name in one cell', () => {
        const cells = cellsOf(dependency({name: 'weird,name'}))
        expect(cells).toHaveLength(COLUMNS)
        expect(cells[2]).toBe('weird,name')
    })

    it('keeps multi-line vulnerability details in one cell', () => {
        const vulnerabilities = [
            {severity: 'HIGH', description: '', permalink: 'https://example.test/1'},
            {severity: 'LOW', description: '', permalink: 'https://example.test/2'},
        ]
        const cells = cellsOf(dependency({vulnerabilities}))
        expect(cells).toHaveLength(COLUMNS)
        expect(cells[10]).toBe('2')
        expect(cells[11]).toBe('HIGH - https://example.test/1\nLOW - https://example.test/2')
    })

    it('keeps a multi-licence list in one cell', () => {
        const libraryInfo = {name: 'lib', versions: [], licenses: ['MIT', 'Apache-2.0']} as unknown as LibraryInfo
        const cells = cellsOf(dependency({libraryInfo}))
        expect(cells).toHaveLength(COLUMNS)
        expect(cells[14]).toBe('MIT,Apache-2.0')
    })

    it('emits every column even when the library was never enriched', () => {
        expect(cellsOf(dependency({libraryInfo: undefined}))).toHaveLength(COLUMNS)
    })
})
