import {describe, expect, it} from 'vitest'
import {buildVulnerabilityIndex, type PackageKeyer} from '../../src/index.js'
import {grypeReport, LOG4J, MINIMIST, ONLY_TRIVY, trivyReport} from './reports.js'

/** Keys each finding by the purl its bom-ref stands for, as the vuln server does. */
const refs = new Map([['c0', LOG4J], ['c1', ONLY_TRIVY], ['c2', MINIMIST]])
const byRef: PackageKeyer = scanned => {
    const purl = scanned.ref === undefined ? undefined : refs.get(scanned.ref)
    return purl === undefined ? undefined : {mergeKey: scanned.ref!, indexKeys: [purl]}
}

describe('buildVulnerabilityIndex — cross-tool union and merge', () => {
    const {index, unmapped} = buildVulnerabilityIndex(trivyReport, grypeReport, byRef)

    it('lists findings under the keyer\'s index keys, and maps every finding', () => {
        expect([...index.keys()].sort()).toEqual([LOG4J, MINIMIST, ONLY_TRIVY].sort())
        expect(unmapped).toBe(0)
    })

    it('dedups the same (package, CVE) finding reported by both tools', () => {
        expect(index.get(LOG4J)).toHaveLength(1)
    })

    it('merges field-level: Grype range and score, Trivy timestamp, unioned references and identifiers', () => {
        const v = index.get(LOG4J)![0]!
        expect(v.vulnerableRange).toBe('>=2.4,<2.12.2')          // Grype's
        expect(v.score).toBe(10.0)                                // Grype's
        expect(v.timestamp).toBe(Date.parse('2021-12-10T10:15:09.143Z')) // Trivy's
        expect(v.severity).toBe('CRITICAL')
        expect(v.summary).toBe('log4shell')                       // only Trivy has titles
        expect(v.source).toBe('trivy,grype')
        expect(v.identifiers).toEqual(expect.arrayContaining([
            {value: 'CVE-2021-44228', type: 'CVE'},
            {value: 'GHSA-jfh8-c2jp-5v3q', type: 'GHSA'},
        ]))
        const references = v.references ?? []
        expect(references).toEqual(expect.arrayContaining([
            'https://trivy.example/ref1', 'https://grype.example/ref2', 'https://shared.example/ref',
        ]))
        // the shared reference is unioned, not duplicated
        expect(references.filter(r => r === 'https://shared.example/ref')).toHaveLength(1)
    })

    it('keeps single-tool findings from either side', () => {
        expect(index.get(ONLY_TRIVY)).toHaveLength(1)
        const grypeOnly = index.get(MINIMIST)!
        expect(grypeOnly).toHaveLength(1)
        expect(grypeOnly[0]!.description).toBe('only grype knows this one')
    })

    it('pins findings without a range to the exact installed version, so no filter can drop them', () => {
        expect(index.get(ONLY_TRIVY)![0]!.vulnerableRange).toBe('=1.0.0')
        expect(index.get(MINIMIST)![0]!.vulnerableRange).toBe('=1.2.0')
    })

    it('works with a single tool missing entirely', () => {
        const trivyOnly = buildVulnerabilityIndex(trivyReport, undefined, byRef).index
        expect(trivyOnly.get(LOG4J)![0]!.vulnerableRange).toBe('=2.11.1') // no Grype range -> exact-version pin
        const grypeOnly = buildVulnerabilityIndex(undefined, grypeReport, byRef).index
        expect(grypeOnly.get(LOG4J)).toHaveLength(1)
    })
})

describe('buildVulnerabilityIndex — keys', () => {
    it('drops and counts a finding the keyer cannot place', () => {
        const {index, unmapped} = buildVulnerabilityIndex(
            {Results: [{Vulnerabilities: [
                {VulnerabilityID: 'CVE-2099-1', PkgIdentifier: {BOMRef: 'c9'}},
                {VulnerabilityID: 'CVE-2099-2', PkgIdentifier: {BOMRef: 'c0'}},
            ]}]},
            undefined, byRef,
        )
        expect(unmapped).toBe(1)
        expect(index.get(LOG4J)!.map(v => v.identifiers![0]!.value)).toEqual(['CVE-2099-2'])
    })

    it('lists a merged finding under the union of both tools\' index keys', () => {
        const keyByTool: PackageKeyer = scanned => ({mergeKey: 'log4j', indexKeys: [`${scanned.name}@${scanned.version}`]})
        const {index} = buildVulnerabilityIndex(trivyReport, grypeReport, keyByTool)
        const viaTrivy = index.get('org.apache.logging.log4j:log4j-core@2.11.1')!
        const viaGrype = index.get('log4j-core@2.11.1')!
        expect(viaTrivy.find(v => v.source === 'trivy,grype')).toBe(viaGrype.find(v => v.source === 'trivy,grype'))
    })
})
