import {describe, expect, it} from 'vitest'
import {grypeFindings, type GrypeReport} from '../../src/vuln/merge/grype.js'
import {buildVulnerabilityIndex} from '../../src/vuln/merge/index.js'
import {trivyCvss, trivyFindings, type TrivyReport} from '../../src/vuln/merge/trivy.js'

/**
 * Ported from depinder's `__tests__/sbom.local-scan.test.ts`, with packages identified by bom-ref
 * instead of purl and `name@version`. The fixtures mirror the shapes measured in real Trivy /
 * Grype output — notably:
 *  - Trivy keys findings by a full maven PkgName (`group:artifact`) and carries the GHSA alias in
 *    `VendorIDs`; it knows PublishedDate but no vulnerable range.
 *  - Grype keys findings by the BARE artifact name plus the purl, uses a GHSA id as primary with
 *    the CVE in `relatedVulnerabilities`, and suffixes constraints with a format marker
 *    (`>=2.4,<2.12.2 (unknown)`).
 * The merge must therefore dedup through the bom-ref and the CVE id.
 */

const LOG4J = 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1'
const ONLY_TRIVY = 'pkg:maven/com.example/only-trivy@1.0.0'
const MINIMIST = 'pkg:npm/minimist@1.2.0'

/** c0..c2 -> the purls as sent. */
const refs = new Map([['c0', LOG4J], ['c1', ONLY_TRIVY], ['c2', MINIMIST]])

const trivyReport: TrivyReport = {
    Results: [{
        Vulnerabilities: [
            {
                VulnerabilityID: 'CVE-2021-44228',
                VendorIDs: ['GHSA-jfh8-c2jp-5v3q'],
                PkgName: 'org.apache.logging.log4j:log4j-core',
                InstalledVersion: '2.11.1',
                PkgIdentifier: {PURL: LOG4J, BOMRef: 'c0'},
                FixedVersion: '2.15.0, 2.12.2',
                Severity: 'CRITICAL',
                Title: 'log4shell',
                Description: 'JNDI lookup RCE',
                PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2021-44228',
                References: ['https://trivy.example/ref1', 'https://shared.example/ref'],
                PublishedDate: '2021-12-10T10:15:09.143Z',
                CVSS: {ghsa: {V3Score: 10, V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'}, nvd: {V3Score: 9.8, V3Vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', V2Score: 9.3}},
            },
            {
                VulnerabilityID: 'CVE-2020-0001',
                PkgName: 'com.example:only-trivy',
                InstalledVersion: '1.0.0',
                PkgIdentifier: {PURL: ONLY_TRIVY, BOMRef: 'c1'},
                Severity: 'Low',
            },
        ],
    }],
}

const grypeReport: GrypeReport = {
    matches: [
        {
            vulnerability: {
                id: 'GHSA-jfh8-c2jp-5v3q',
                severity: 'Critical',
                description: '', // real Grype GHSA records often have an empty description
                dataSource: 'https://github.com/advisories/GHSA-jfh8-c2jp-5v3q',
                urls: ['https://grype.example/ref2', 'https://shared.example/ref'],
                cvss: [
                    {version: '2.0', metrics: {baseScore: 9.3}},
                    {version: '3.1', metrics: {baseScore: 10.0}},
                ],
                fix: {versions: ['2.12.2']},
            },
            relatedVulnerabilities: [{
                id: 'CVE-2021-44228',
                description: 'JNDI features do not protect against attacker controlled endpoints',
                urls: ['https://nvd.nist.gov/vuln/detail/CVE-2021-44228'],
            }],
            matchDetails: [{found: {versionConstraint: '>=2.4,<2.12.2 (unknown)'}}],
            // Grype's artifact.name is the bare artifactId — the purl carries the groupId.
            artifact: {id: 'c0', name: 'log4j-core', version: '2.11.1', purl: LOG4J},
        },
        {
            vulnerability: {
                id: 'GHSA-aaaa-bbbb-cccc',
                severity: 'Medium',
                description: 'only grype knows this one',
                dataSource: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
            },
            matchDetails: [{found: {versionConstraint: 'none (unknown)'}}],
            artifact: {id: 'c2', name: 'minimist', version: '1.2.0', purl: MINIMIST},
        },
    ],
}

describe('trivyFindings', () => {
    it('maps one finding with ids (incl. GHSA alias), GHSA CVSS score, timestamp and first fix version', () => {
        const [f] = trivyFindings(trivyReport)
        expect(f!.ref).toBe('c0')
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
        expect(f!.installedVersion).toBe('2.11.1')
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
        expect(f!.ref).toBe('c0')
        expect(f!.purl).toBe(LOG4J)
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
        const [f] = grypeFindings({matches: [{
            vulnerability: {id: 'GHSA-mw96-cpmx-2vgc', cvss: [
                {version: '4.0', vector: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:N/SC:N/SI:N/SA:N/E:P', metrics: {baseScore: 8.8}},
            ]},
            relatedVulnerabilities: [{id: 'CVE-2026-27606', cvss: [
                {source: 'nvd@nist.gov', version: '3.1', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', metrics: {baseScore: 9.8}},
            ]}],
            artifact: {id: 'c0', name: 'rollup', version: '2.79.2', purl: 'pkg:npm/rollup@2.79.2'},
        }]})
        expect(f!.score).toBe(8.8)
        expect(f!.cvssVersion).toBe('4.0')
        const [g] = grypeFindings({matches: [{
            vulnerability: {id: 'GHSA-mw96-cpmx-2vgc'},
            relatedVulnerabilities: [{id: 'CVE-2026-27606', cvss: [
                {source: 'nvd@nist.gov', version: '3.1', vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', metrics: {baseScore: 9.8}},
            ]}],
            artifact: {id: 'c0', name: 'rollup', version: '2.79.2', purl: 'pkg:npm/rollup@2.79.2'},
        }]})
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

describe('buildVulnerabilityIndex — cross-tool union and merge', () => {
    const {index, unmapped} = buildVulnerabilityIndex(trivyReport, grypeReport, refs)

    it('keys the answer by the purls as sent, and maps every finding', () => {
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
        const refs = v.references ?? []
        expect(refs).toEqual(expect.arrayContaining([
            'https://trivy.example/ref1', 'https://grype.example/ref2', 'https://shared.example/ref',
        ]))
        // the shared reference is unioned, not duplicated
        expect(refs.filter(r => r === 'https://shared.example/ref')).toHaveLength(1)
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
        const trivyOnly = buildVulnerabilityIndex(trivyReport, undefined, refs).index
        const v = trivyOnly.get(LOG4J)![0]!
        expect(v.vulnerableRange).toBe('=2.11.1') // no Grype range -> exact-version pin
        const grypeOnly = buildVulnerabilityIndex(undefined, grypeReport, refs).index
        expect(grypeOnly.get(LOG4J)).toHaveLength(1)
    })
})

describe('buildVulnerabilityIndex — refs', () => {
    const TOML = 'pkg:golang/github.com/BurntSushi/toml@v0.3.1'

    it('lands a Trivy finding on the mixed-case purl that was sent, whatever Trivy calls the package', () => {
        // Trivy lowercases a golang path in both PkgName and PURL; only the ref is ours.
        const {index} = buildVulnerabilityIndex({Results: [{Vulnerabilities: [{
            VulnerabilityID: 'CVE-2099-1',
            PkgName: 'github.com/burntsushi/toml',
            InstalledVersion: 'v0.3.1',
            PkgIdentifier: {PURL: 'pkg:golang/github.com/burntsushi/toml@v0.3.1', BOMRef: 'c0'},
        }]}]}, undefined, new Map([['c0', TOML]]))
        expect([...index.keys()]).toEqual([TOML])
    })

    it('falls back to the exact artifact.purl when Grype\'s artifact.id is not one of ours', () => {
        const report: GrypeReport = {matches: [{
            vulnerability: {id: 'GHSA-xxxx-yyyy-zzzz'},
            artifact: {id: '6f2a9c01d', name: 'toml', version: 'v0.3.1', purl: 'pkg:golang/github.com/BurntSushi/toml@v0.3.1'},
        }]}
        const sent = `${TOML}?vcs_url=x`
        const {index, unmapped} = buildVulnerabilityIndex(undefined, report, new Map([['c0', sent]]), new Map([[TOML, 'c0']]))
        expect([...index.keys()]).toEqual([sent])
        expect(unmapped).toBe(0)
    })

    it('drops and counts a finding whose ref maps to nothing', () => {
        const {index, unmapped} = buildVulnerabilityIndex(
            {Results: [{Vulnerabilities: [
                {VulnerabilityID: 'CVE-2099-1', PkgIdentifier: {BOMRef: 'c9'}},
                {VulnerabilityID: 'CVE-2099-2', PkgIdentifier: {}},
                {VulnerabilityID: 'CVE-2099-3', PkgIdentifier: {BOMRef: 'c0'}},
            ]}]},
            {matches: [{vulnerability: {id: 'GHSA-1'}, artifact: {id: 'zz', purl: 'pkg:npm/unknown@1'}}]},
            new Map([['c0', TOML]]),
            new Map([[TOML, 'c0']]),
        )
        expect(unmapped).toBe(3)
        expect([...index.keys()]).toEqual([TOML])
        expect(index.get(TOML)!.map(v => v.identifiers![0]!.value)).toEqual(['CVE-2099-3'])
    })

    it('keeps the same CVE apart on two refs, even for two spellings of one package', () => {
        const same = (ref: string) => ({VulnerabilityID: 'CVE-2099-1', PkgIdentifier: {BOMRef: ref}})
        const {index} = buildVulnerabilityIndex(
            {Results: [{Vulnerabilities: [same('c0'), same('c1')]}]}, undefined,
            new Map([['c0', 'pkg:npm/a@1'], ['c1', 'pkg:npm/a@1?x=y']]),
        )
        expect(index.get('pkg:npm/a@1')).toHaveLength(1)
        expect(index.get('pkg:npm/a@1?x=y')).toHaveLength(1)
    })
})
