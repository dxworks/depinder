import {describe, expect, it} from 'vitest'
import {pseudoVersionTime} from '../../src/registries/golang-pseudo-version.js'

describe('pseudoVersionTime', () => {
    const pseudoVersions: [string, string][] = [
        // no earlier tag
        ['v0.0.0-20260410095643-abcdef123456', '2026-04-10T09:56:43.000Z'],
        // after the release tag v1.1.7
        ['v1.1.8-0.20240110162603-74a5dd331745', '2024-01-10T16:26:03.000Z'],
        // after the pre-release tag v2.0.0-pre
        ['v2.0.0-pre.0.20230729083705-37449abec8cc', '2023-07-29T08:37:05.000Z'],
        ['v2.0.0-rc.1.0.20230729083705-37449abec8cc', '2023-07-29T08:37:05.000Z'],
        // a module without go.mod past v1
        ['v3.0.0-20210328193216-ff5ff6dc229b+incompatible', '2021-03-28T19:32:16.000Z'],
    ]
    for (const [version, time] of pseudoVersions) {
        it(`reads ${version} as ${time}`, () => {
            expect(pseudoVersionTime(version)?.toISOString()).toBe(time)
        })
    }

    const others = [
        'v1.5.4', // a tag
        'v1.2.3-beta.1',
        'v1.2.3-20210328193216-ff5ff6dc229b', // the no-tag shape needs vX.0.0
        'v0.0.0-2021032819321-ff5ff6dc229b', // 13 digits
        'v0.0.0-20210328193216', // no revision
        '0.0.0-20210328193216-ff5ff6dc229b', // no v
        'v01.0.0-20210328193216-ff5ff6dc229b', // a leading zero is not semver
        'v1.0.0-pre.01.0.20210328193216-ff5ff6dc229b',
        'v0.0.0-20211328193216-ff5ff6dc229b', // month 13
        'v0.0.0-20210230120000-ff5ff6dc229b', // 30 February
        'v0.0.0-20210328246000-ff5ff6dc229b', // hour 24
        '',
    ]
    for (const version of others) {
        it(`has no time for ${JSON.stringify(version)}`, () => {
            expect(pseudoVersionTime(version)).toBeNull()
        })
    }
})
