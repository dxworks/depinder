import {describe, expect, it} from 'vitest'
import {BadRequestError} from '../../src/shared/errors.js'
import {parseVulnRequest, TooManyPurlsError} from '../../src/vuln/request.js'

describe('parseVulnRequest', () => {
    it('refuses a body that is not {purls: string[]}', () => {
        for (const body of [undefined, null, 'x', [], {}, {purls: 'pkg:npm/a@1'}, {purls: [1]}, {purls: ['pkg:npm/a@1', null]}]) {
            expect(() => parseVulnRequest(body, 10), JSON.stringify(body)).toThrow(BadRequestError)
        }
    })

    it('accepts an empty list', () => {
        expect(parseVulnRequest({purls: []}, 10)).toEqual({scan: [], unsupported: []})
    })

    it('removes exact duplicates, keeping first-seen order', () => {
        const {scan} = parseVulnRequest({purls: ['pkg:npm/b@1', 'pkg:npm/a@1', 'pkg:npm/b@1', 'pkg:npm/A@1']}, 10)
        // `A` and `a` are two strings, so two keys.
        expect(scan.map(s => s.purl)).toEqual(['pkg:npm/b@1', 'pkg:npm/a@1', 'pkg:npm/A@1'])
    })

    it('counts distinct purls against the limit: 413 at max + 1', () => {
        const purls = Array.from({length: 5}, (_, i) => `pkg:npm/p${i}@1`)
        expect(parseVulnRequest({purls: [...purls, ...purls]}, 5).scan).toHaveLength(5)
        expect(() => parseVulnRequest({purls: [...purls, 'pkg:npm/one-more@1']}, 5)).toThrow(TooManyPurlsError)
        try {
            parseVulnRequest({purls: [...purls, 'pkg:npm/one-more@1']}, 5)
        } catch (e) {
            expect((e as TooManyPurlsError).max).toBe(5)
        }
    })

    it('sorts out what cannot be scanned, with the reason, in order', () => {
        const {scan, unsupported} = parseVulnRequest({
            purls: [
                'not a purl',
                'pkg:npm/lodash',
                'pkg:github/actions/checkout@v4',
                'pkg:maven/guava@1.0',
                'pkg:npm/lodash@4.17.21',
                'pkg:pypi/requests@',
                '',
            ],
        }, 10)
        expect(scan.map(s => s.purl)).toEqual(['pkg:npm/lodash@4.17.21'])
        expect(unsupported).toEqual([
            {purl: 'not a purl', reason: 'invalid'},
            {purl: 'pkg:npm/lodash', reason: 'no_version'},
            {purl: 'pkg:github/actions/checkout@v4', reason: 'unsupported_type'},
            // A maven purl needs its group.
            {purl: 'pkg:maven/guava@1.0', reason: 'invalid'},
            {purl: 'pkg:pypi/requests@', reason: 'no_version'},
            {purl: '', reason: 'invalid'},
        ])
    })

    it('keeps the purl as sent and strips qualifiers and subpath only for the scan', () => {
        const sent = 'pkg:maven/org.yaml/snakeyaml@1.33?type=jar&classifier=x#sub/path'
        const [item] = parseVulnRequest({purls: [sent]}, 10).scan
        expect(item).toEqual({
            purl: sent,
            bare: 'pkg:maven/org.yaml/snakeyaml@1.33',
            type: 'maven',
            namespace: 'org.yaml',
            name: 'snakeyaml',
            version: '1.33',
        })
        expect(parseVulnRequest({purls: ['pkg:npm/a@1#sub']}, 10).scan[0]!.bare).toBe('pkg:npm/a@1')
    })

    it('takes the raw decoded parts, not the canonical ones', () => {
        const {scan} = parseVulnRequest({
            purls: ['pkg:npm/%40NestJS/Core@10.0.0', 'pkg:pypi/Django_Rest.Framework@3.0', 'pkg:nuget/Newtonsoft.Json@13.0.1'],
        }, 10)
        expect(scan.map(s => [s.namespace, s.name, s.version])).toEqual([
            ['@NestJS', 'Core', '10.0.0'],
            [null, 'Django_Rest.Framework', '3.0'],
            [null, 'Newtonsoft.Json', '13.0.1'],
        ])
    })
})
