import {describe, expect, it} from 'vitest'
import {grypeFindings} from '../../src/vuln/grype.js'
import {trivyCvss, trivyFindings} from '../../src/vuln/trivy.js'
import {grypeReport, LOG4J, trivyReport} from './reports.js'

describe('trivyFindings', () => {
    it('maps one finding with ids (incl. GHSA alias), GHSA CVSS score, timestamp and first fix version', () => {
        const [f] = trivyFindings(trivyReport)
        expect(f!.package).toEqual({ref: 'c0', purl: LOG4J, name: 'org.apache.logging.log4j:log4j-core', version: '2.11.1'})
        expect(f!.ids).toEqual(['CVE-2021-44228', 'GHSA-jfh8-c2jp-5v3q'])
        expect(f!.severity).toBe('CRITICAL')
        expect(f!.score).toBe(10)                                  // GHSA's block, not NVD's
        expect(f!.cvssVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')
        expect(f!.cvssVersion).toBe('3.1')
        expect(f!.timestamp).toBe(Date.parse('2021-12-10T10:15:09.143Z'))
        expect(f!.summary).toBe('log4shell')
        expect(f!.firstPatchedVersion).toBe('2.15.0')
        expect(f!.patchedVersions).toEqual(['2.15.0', '2.12.2']) // one fix per maintained line
        expect(f!.vulnerableRange).toBeUndefined() // Trivy reports no range against an SBOM
    })

    it('takes GHSA\'s block first, whichever CVSS it uses, then NVD\'s, then the highest of the rest', () => {
        const v4 = {V40Score: 8.7, V40Vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N'}
        const nvd = {V3Score: 5.3, V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N'}
        expect(trivyCvss({nvd, ghsa: v4})).toEqual({score: 8.7, cvssVector: v4.V40Vector, cvssVersion: '4.0'})
        // Older trivy put GHSA's CVSS 4 vector under V3Vector; the vector still says which it is.
        expect(trivyCvss({ghsa: {V3Score: 8.7, V3Vector: v4.V40Vector}}).cvssVersion).toBe('4.0')
        expect(trivyCvss({nvd, redhat: {V3Score: 7.5, V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'}}))
            .toEqual({score: 5.3, cvssVector: nvd.V3Vector, cvssVersion: '3.1'})
        expect(trivyCvss({redhat: {V3Score: 7.5, V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N'}, bitnami: {V3Score: 5.3, V3Vector: nvd.V3Vector}}).score).toBe(7.5)
        expect(trivyCvss({nvd: {V2Score: 5.0, V2Vector: 'AV:N/AC:L/Au:N/C:P/I:N/A:N'}}))
            .toEqual({score: 5.0, cvssVector: 'AV:N/AC:L/Au:N/C:P/I:N/A:N', cvssVersion: '2.0'})
        expect(trivyCvss(undefined)).toEqual({})
    })

    it('uppercases severities that arrive mixed-case', () => {
        expect(trivyFindings(trivyReport)[1]!.severity).toBe('LOW')
    })
})

describe('grypeFindings', () => {
    it('prefers the CVSS v3 score and strips the format suffix from the constraint', () => {
        const [f] = grypeFindings(grypeReport)
        expect(f!.package).toEqual({ref: 'c0', purl: LOG4J, name: 'log4j-core', version: '2.11.1'})
        expect(f!.score).toBe(10.0)
        expect(f!.cvssVersion).toBe('3.1')
        expect(f!.vulnerableRange).toBe('>=2.4,<2.12.2')
        expect(f!.firstPatchedVersion).toBe('2.12.2')
        expect(f!.patchedVersions).toEqual(['2.12.2'])
    })

    it('takes GitHub\'s score over NVD\'s when Grype lists both', () => {
        const [f] = grypeFindings({matches: [{
            vulnerability: {id: 'CVE-2020-1', cvss: [
                {source: 'nvd@nist.gov', version: '3.1', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', metrics: {baseScore: 6.5}},
                {source: 'github.com/advisories', version: '3.1', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N', metrics: {baseScore: 7.5}},
            ]},
            artifact: {id: 'c0', name: 'x', version: '1', purl: 'pkg:npm/x@1'},
        }]})
        expect(f!.score).toBe(7.5)
        expect(f!.cvssVector).toBe('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N')
    })

    it('keeps the GHSA record\'s own CVSS 4 over NVD\'s v3 on the related CVE record, and falls back to it', () => {
        const nvdOnCve = [{id: 'CVE-2026-27606', cvss: [
            {source: 'nvd@nist.gov', version: '3.1', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', metrics: {baseScore: 9.8}},
        ]}]
        const artifact = {id: 'c0', name: 'rollup', version: '2.79.2', purl: 'pkg:npm/rollup@2.79.2'}
        const [f] = grypeFindings({matches: [{
            vulnerability: {id: 'GHSA-mw96-cpmx-2vgc', cvss: [
                {version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/E:P', metrics: {baseScore: 8.8}},
            ]},
            relatedVulnerabilities: nvdOnCve,
            artifact,
        }]})
        expect(f!.score).toBe(8.8)
        expect(f!.cvssVersion).toBe('4.0')
        const [g] = grypeFindings({matches: [{vulnerability: {id: 'GHSA-mw96-cpmx-2vgc'}, relatedVulnerabilities: nvdOnCve, artifact}]})
        expect(g!.score).toBe(9.8)
    })

    it('collects the CVE id and description from relatedVulnerabilities', () => {
        const [f] = grypeFindings(grypeReport)
        expect(f!.ids).toEqual(['GHSA-jfh8-c2jp-5v3q', 'CVE-2021-44228'])
        expect(f!.description).toContain('JNDI features')
    })

    it('drops the placeholder "none" constraint', () => {
        expect(grypeFindings(grypeReport)[1]!.vulnerableRange).toBeUndefined()
    })
})
