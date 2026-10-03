import {advisoriesMatchingVersion, resolveVulnerabilities} from '../src/commands/analyse'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/registrar'
import {Vulnerability} from '../src/extension-points/vulnerability-checker'

function vuln(vulnerableRange?: string): Vulnerability {
    return {
        severity: 'HIGH',
        description: 'boom',
        permalink: 'https://example.test/GHSA-0000',
        vulnerableRange,
    }
}

function library(vulnerabilities?: Vulnerability[]): LibraryInfo {
    return {name: 'lib', versions: [], vulnerabilities} as unknown as LibraryInfo
}

function dependency(version: string, vulnerabilities?: Vulnerability[]): DepinderDependency {
    return {id: `lib@${version}`, name: 'lib', version, semver: null, requestedBy: [], vulnerabilities}
}

function project(exactVersionVulnerabilities?: boolean): DepinderProject {
    return {name: 'p', version: '1.0.0', path: '/p', dependencies: {}, exactVersionVulnerabilities}
}

describe('advisoriesMatchingVersion', () => {
    it('keeps an advisory whose range covers the used version', () => {
        expect(advisoriesMatchingVersion(library([vuln('>= 1.0.0, < 2.0.0')]), '1.5.0')).toHaveLength(1)
    })

    it('drops an advisory whose range does not cover the used version', () => {
        expect(advisoriesMatchingVersion(library([vuln('>= 2.0.0')]), '1.5.0')).toHaveLength(0)
    })

    it('drops, rather than throws on, an unparseable range', () => {
        expect(advisoriesMatchingVersion(library([vuln('not a range at all')]), '1.5.0')).toHaveLength(0)
    })

    it('returns an empty array when the library carries no advisories', () => {
        expect(advisoriesMatchingVersion(library(undefined), '1.5.0')).toEqual([])
    })
})

describe('resolveVulnerabilities', () => {
    it('takes a scanner result verbatim, even when the range filter would drop it', () => {
        // The regression test for the requirement that scanner findings are never range-filtered.
        const scanned = vuln('>= 99.0.0')
        const dep = dependency('1.5.0', [scanned])
        expect(resolveVulnerabilities(project(true), dep, library([vuln('>= 1.0.0')]))).toEqual([scanned])
    })

    it('returns [] for a dependency the scan did not match, without falling back to advisories', () => {
        const dep = dependency('1.5.0', [])
        expect(resolveVulnerabilities(project(true), dep, library([vuln('>= 1.0.0')]))).toEqual([])
    })

    it('range-filters the library advisories when no scanner ran', () => {
        const inRange = vuln('>= 1.0.0, < 2.0.0')
        const dep = dependency('1.5.0')
        expect(resolveVulnerabilities(project(), dep, library([inRange, vuln('>= 9.0.0')]))).toEqual([inRange])
    })

    it('returns [] when no scanner ran and the library has no advisories', () => {
        expect(resolveVulnerabilities(project(), dependency('1.5.0'), library(undefined))).toEqual([])
    })
})
