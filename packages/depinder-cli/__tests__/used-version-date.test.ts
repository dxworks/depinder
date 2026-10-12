import {AnalysedEcosystem, buildModel} from '../src/blackduck/model'
import {DepinderDependency} from '../src/extension-points/extract'
import {LibraryInfo, usedVersionTimestamp} from '../src/extension-points/library-info'

/** golang.org/x/sys as the proxy lists it: tags only, never the pseudo-versions projects pin. */
const xSys: LibraryInfo = {
    name: 'golang.org/x/sys',
    licenses: ['BSD-3-Clause'],
    versions: [
        {version: 'v0.30.0', timestamp: Date.parse('2025-02-04T00:00:00Z'), latest: false},
        {version: 'v0.31.0', timestamp: Date.parse('2025-03-04T00:00:00Z'), latest: false},
        {version: 'v0.32.0', timestamp: Date.parse('2025-04-02T00:00:00Z'), latest: true},
    ],
}

const PSEUDO = 'v0.30.1-0.20250220120000-abcdef123456'

describe('usedVersionTimestamp', () => {
    it('takes the registry date of a listed version', () => {
        expect(usedVersionTimestamp(xSys.versions, ' v0.31.0 ')).toBe(Date.parse('2025-03-04T00:00:00Z'))
    })

    it('reads an unlisted pseudo-version from the commit time it carries', () => {
        expect(usedVersionTimestamp(xSys.versions, PSEUDO)).toBe(Date.parse('2025-02-20T12:00:00Z'))
        expect(usedVersionTimestamp(undefined, PSEUDO)).toBe(Date.parse('2025-02-20T12:00:00Z'))
    })

    it('reads a listed pseudo-version without a date the same way', () => {
        const undated = [{version: PSEUDO, timestamp: NaN, latest: true}]
        expect(usedVersionTimestamp(undated, PSEUDO)).toBe(Date.parse('2025-02-20T12:00:00Z'))
    })

    it('knows nothing of an unlisted tag', () => {
        expect(usedVersionTimestamp(xSys.versions, 'v0.29.0')).toBeUndefined()
        expect(usedVersionTimestamp([{version: 'v0.29.0', timestamp: NaN, latest: true}], 'v0.29.0')).toBeNaN()
    })
})

describe('Black Duck columns for a Go pseudo-version', () => {
    it('get its release date, and versions released after it count as newer', () => {
        const dependency = {
            id: `golang.org/x/sys@${PSEUDO}`,
            name: 'golang.org/x/sys',
            version: PSEUDO,
            requestedBy: ['app@1.0.0'],
            libraryInfo: xSys,
        } as DepinderDependency
        const ecosystem: AnalysedEcosystem = {
            purlType: 'golang',
            projects: [{name: 'app', version: '1.0.0', path: 'go.mod', dependencies: {[dependency.id]: dependency}}],
        }

        const [component] = buildModel('app', [ecosystem], []).components
        expect(component.releaseDate).toBe('2025-02-20')
        expect(component.newerVersions).toBe('2')
    })
})
