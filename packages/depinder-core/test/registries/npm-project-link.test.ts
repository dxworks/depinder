import {describe, expect, it} from 'vitest'
import {npmProjectLink, packageFromPackument} from '../../src/registries/npm.js'
import {fixtureJson} from './registry.helpers.js'

// The npm Component Link rule copied from the CLI (D9).

const time = {
    '1.0.0': '2020-01-01T00:00:00.000Z',
    '2.0.0': '2021-01-01T00:00:00.000Z',
    '3.0.0': '2022-01-01T00:00:00.000Z',
}

describe('npmProjectLink', () => {
    it('takes the top-level homepage first', () => {
        const doc = {
            homepage: 'https://top.example',
            time,
            versions: {'3.0.0': {version: '3.0.0', homepage: 'https://v3.example'}},
        }
        expect(npmProjectLink(doc)).toBe('https://top.example')
    })

    it('else takes the newest version that declares a homepage', () => {
        const doc = {
            time,
            versions: {
                '1.0.0': {version: '1.0.0', homepage: 'https://v1.example'},
                '2.0.0': {version: '2.0.0', homepage: 'https://v2.example'},
                '3.0.0': {version: '3.0.0'},
            },
        }
        expect(npmProjectLink(doc)).toBe('https://v2.example')
    })

    it('takes a newer version repository, as declared, over an older homepage', () => {
        const doc = {
            time,
            versions: {
                '1.0.0': {version: '1.0.0', homepage: 'https://v1.example'},
                '2.0.0': {version: '2.0.0', repository: {type: 'git', url: 'git+https://github.com/o/r.git'}},
                '3.0.0': {version: '3.0.0', homepage: '  '},
            },
        }
        expect(npmProjectLink(doc)).toBe('git+https://github.com/o/r.git')
    })

    it('accepts a repository spelled as a plain string', () => {
        const doc = {time, versions: {'1.0.0': {version: '1.0.0', repository: 'github:o/r'}}}
        expect(npmProjectLink(doc)).toBe('github:o/r')
    })

    it('is undefined when no version declares anything', () => {
        const doc = {time, versions: {'1.0.0': {version: '1.0.0'}, '2.0.0': {version: '2.0.0', repository: {}}}}
        expect(npmProjectLink(doc)).toBeUndefined()
        expect(npmProjectLink({})).toBeUndefined()
    })

    it('gives unit-parser the homepage of its older 0.0.7', () => {
        const unitParser = fixtureJson('cases/npm-homepage-from-older-version/packument')
        expect(packageFromPackument(unitParser).homepageUrl).toBe('https://github.com/jakubknejzlik/unit-parser#readme')
    })
})
