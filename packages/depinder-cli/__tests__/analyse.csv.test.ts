import {parse} from 'csv-parse/sync'
import {convertDepToRow} from '../src/commands/analyse'
import {csvRow} from '../src/utils/csv'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/library-info'

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

    // A cold npm run built [undefined] for a package with no licence; the cache stored it as
    // [null], and a warm run wrote the text `null`. Both must give the same empty cell.
    it.each([
        ['[null]', [null]],
        ['[undefined]', [undefined]],
    ])('writes an empty Licenses cell for %s', (_, licenses) => {
        const libraryInfo = {name: 'lib', versions: [], licenses} as unknown as LibraryInfo
        const cells = cellsOf(dependency({libraryInfo}))
        expect(cells).toHaveLength(COLUMNS)
        expect(cells[14]).toBe('')
    })

    it('drops a null entry but keeps the real licences beside it', () => {
        const libraryInfo = {name: 'lib', versions: [], licenses: [null, 'MIT']} as unknown as LibraryInfo
        expect(cellsOf(dependency({libraryInfo}))[14]).toBe('MIT')
    })

    describe('the date columns', () => {
        // Used Version Release Date, Latest Version Release Date, Latest-Used, Now-Used, Now-latest.
        const DATES = [5, 6, 7, 8, 9]
        const versions = (used: Partial<{timestamp: number, yanked: boolean}>) => ({
            name: 'lib', licenses: ['MIT'], versions: [
                {version: '1.0.0', timestamp: Date.parse('2020-01-15T00:00:00Z'), latest: false, ...used},
                {version: '2.0.0', timestamp: Date.parse('2021-03-15T00:00:00Z'), latest: true},
            ],
        } as unknown as LibraryInfo)

        it('dates a yanked used version from the registry, not from now', () => {
            // Blazored.LocalStorage 4.5.0: unlisted on nuget.org, still restored by projects.
            const cells = cellsOf(dependency({libraryInfo: versions({yanked: true})}))
            expect(cells[5]).toBe('Jan 2020')
            expect(cells[6]).toBe('Mar 2021')
            expect(cells[7]).toBe('14')
            expect(Number(cells[8])).toBeGreaterThan(60)
        })

        it('writes blank cells, not this month, for a used version the registry does not list', () => {
            const cells = cellsOf(dependency({version: '0.9.0', libraryInfo: versions({})}))
            expect(cells).toHaveLength(COLUMNS)
            expect([cells[5], cells[7], cells[8]]).toEqual(['', '', ''])
            expect(cells[6]).toBe('Mar 2021')
            expect(Number(cells[9])).toBeGreaterThan(60)
        })

        it('writes blank cells, not "Invalid date", for a version the registry has no date for', () => {
            const cells = cellsOf(dependency({libraryInfo: versions({timestamp: NaN})}))
            expect([cells[5], cells[7], cells[8]]).toEqual(['', '', ''])
        })

        it('writes every date column blank when nothing is known', () => {
            const cells = cellsOf(dependency())
            expect(DATES.map(it => cells[it])).toEqual(['', '', '', '', ''])
        })
    })

    it('emits every column even when the library was never enriched', () => {
        expect(cellsOf(dependency({libraryInfo: undefined}))).toHaveLength(COLUMNS)
    })
})
