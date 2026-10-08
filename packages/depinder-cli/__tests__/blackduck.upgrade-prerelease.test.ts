import {type CompactVersion, isPrerelease, type PackageRecord, VERSION_FLAG_PRERELEASE} from '@depinder/core'
import {buildModel} from '../src/blackduck/model'
import {upgradeGuidance} from '../src/blackduck/upgrade'
import {DepinderDependency} from '../src/extension-points/extract'
import {LibraryInfo} from '../src/extension-points/library-info'
import {Vulnerability} from '../src/extension-points/vulnerability-checker'
import {toLibraryInfo} from '../src/resolver/adapter'

/**
 * Upgrade guidance skips a pre-release by the flag the resolver ships (core's `isPrerelease`),
 * not by a rule of its own. The cases are the ones where the CLI's former keyword rule disagreed.
 */

const finding: Vulnerability = {
    severity: 'HIGH',
    description: 'a finding fixed in 1.0.1',
    permalink: 'https://github.com/advisories/GHSA-0000-0000-0000',
    timestamp: 0,
    identifiers: [{value: 'GHSA-0000-0000-0000', type: 'GHSA'}],
    firstPatchedVersion: '1.0.1',
    source: 'github',
}

/** A wire record flagged the way the server flags it. */
function record(type: string, versions: string[], flagged: (version: string) => boolean): PackageRecord {
    const compact: CompactVersion[] = versions.map(version =>
        [version, 0, flagged(version) ? VERSION_FLAG_PRERELEASE : 0])
    return {
        type, namespace: null, name: 'lib', description: null, homepage_url: null, repo_url: null,
        licenses: [], latest: null, latest_prerelease: null, versions: compact,
        as_of: '2026-10-01T00:00:00Z', source: type, fetched_at: '2026-10-01T00:00:00Z', confirmed_at: null,
    }
}

function guidanceFor(purlType: string, libraryInfo: LibraryInfo) {
    const dependency = {
        id: 'lib@1.0.0', name: 'lib', version: '1.0.0', requestedBy: ['app@1.0.0'],
        vulnerabilities: [finding], libraryInfo,
    } as DepinderDependency
    const project = {name: 'app', version: '1.0.0', path: 'manifest', dependencies: {[dependency.id]: dependency}}
    return upgradeGuidance(buildModel('p', [{purlType, projects: [project]}], []).components)[0]
}

const fromResolver = (type: string, versions: string[]) =>
    guidanceFor(type, toLibraryInfo(record(type, versions, version => isPrerelease(type, version))))

describe('the pre-release rule upgrade guidance uses', () => {
    it('skips npm 2.0.0-0, a semver pre-release with no keyword', () => {
        expect(fromResolver('npm', ['1.0.0', '1.0.1', '2.0.0-0']).longTerm).toBe('1.0.1')
    })

    it.each(['nightly', 'canary', 'unstable'])('counts maven -%s as stable, as the resolver does', qualifier => {
        const guidance = fromResolver('maven', ['1.0.0', '1.0.1', `1.1.0-${qualifier}`])
        expect(guidance.shortTerm).toBe(`1.1.0-${qualifier}`)
        expect(guidance.longTerm).toBe(`1.1.0-${qualifier}`)
    })

    it('trusts the flag over the version string', () => {
        // rubygems marks `1.1.0.pre1` a pre-release; core's string rule alone would not.
        const flagged = toLibraryInfo(record('gem', ['1.0.0', '1.0.1', '1.1.0.pre1'], version => version.includes('pre')))
        expect(guidanceFor('gem', flagged).longTerm).toBe('1.0.1')
    })

    it('judges a version cached without the flag by core\'s rule', () => {
        const unflagged: LibraryInfo = {
            name: 'lib', licenses: [],
            versions: ['1.0.0', '1.0.1', '2.0.0-0'].map(version => ({version, timestamp: 0, latest: false})),
        }
        expect(guidanceFor('npm', unflagged).longTerm).toBe('1.0.1')
    })
})
