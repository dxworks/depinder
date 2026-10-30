import {AnalysedEcosystem} from '../../src/blackduck/model'
import {DepinderDependency, DepinderProject} from '../../src/extension-points/extract'
import {Vulnerability} from '../../src/extension-points/vulnerability-checker'

export const advisory: Vulnerability = {
    severity: 'HIGH',
    score: 9.8,
    description: 'qs prototype pollution',
    permalink: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
    timestamp: Date.parse('2022-11-27T00:30:50Z'),
    identifiers: [
        {value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'},
        {value: 'CVE-2022-24999', type: 'CVE'},
    ],
    firstPatchedVersion: '6.10.3',
    source: 'github',
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    cvssVersion: '3.1',
    cweIds: ['CWE-1321'],
}

export function dependency(overrides: Partial<DepinderDependency> = {}): DepinderDependency {
    const name = overrides.name ?? 'qs'
    const version = overrides.version ?? '6.10.2'
    return {
        id: `${name}@${version}`,
        name,
        version,
        requestedBy: ['js-npm-nest@1.0.0'],
        vulnerabilities: [advisory],
        libraryInfo: {
            name: 'qs',
            licenses: ['BSD-3-Clause'],
            homepageUrl: 'https://github.com/ljharb/qs',
            versions: [
                {version: '6.10.2', timestamp: Date.parse('2021-10-06T00:00:00Z'), latest: false},
                {version: '6.10.3', timestamp: Date.parse('2022-01-01T00:00:00Z'), latest: false},
                {version: '6.11.0', timestamp: Date.parse('2022-06-01T00:00:00Z'), latest: true},
            ],
        },
        ...overrides,
    }
}

export function ecosystem(...dependencies: DepinderDependency[]): AnalysedEcosystem {
    const project: DepinderProject = {
        name: 'js-npm-nest',
        version: '1.0.0',
        path: 'package.json',
        dependencies: Object.fromEntries(dependencies.map(it => [it.id, it])),
    }
    return {purlType: 'npm', projects: [project]}
}
