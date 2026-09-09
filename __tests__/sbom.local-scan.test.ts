import {
    buildVulnerabilityIndex,
    grypeFindings,
    packageKeys,
    trivyFindings,
    GrypeReport,
    TrivyReport,
} from '../src/plugins/sbom/local-scan'

/**
 * Fixtures mirror the shapes measured in real Trivy 0.72.0 / Grype 0.115.0 output over the
 * Zeppelin SBOMs — notably:
 *  - Trivy keys findings by a full maven PkgName (`group:artifact`) and carries the GHSA alias in
 *    `VendorIDs`; it knows PublishedDate but no vulnerable range.
 *  - Grype keys findings by the BARE artifact name plus the purl, uses a GHSA id as primary with
 *    the CVE in `relatedVulnerabilities`, and suffixes constraints with a format marker
 *    (`>=2.4,<2.12.2 (unknown)`).
 * The merge must therefore dedup through the purl-derived name@version and the CVE id.
 */

const trivyReport: TrivyReport = {
    Results: [{
        Vulnerabilities: [
            {
                VulnerabilityID: 'CVE-2021-44228',
                VendorIDs: ['GHSA-jfh8-c2jp-5v3q'],
                PkgName: 'org.apache.logging.log4j:log4j-core',
                InstalledVersion: '2.11.1',
                PkgIdentifier: {PURL: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1'},
                FixedVersion: '2.15.0, 2.12.2',
                Severity: 'CRITICAL',
                Title: 'log4shell',
                Description: 'JNDI lookup RCE',
                PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2021-44228',
                References: ['https://trivy.example/ref1', 'https://shared.example/ref'],
                PublishedDate: '2021-12-10T10:15:09.143Z',
                CVSS: {ghsa: {V3Score: 10}, nvd: {V3Score: 9.8, V2Score: 9.3}},
            },
            {
                VulnerabilityID: 'CVE-2020-0001',
                PkgName: 'com.example:only-trivy',
                InstalledVersion: '1.0.0',
                PkgIdentifier: {PURL: 'pkg:maven/com.example/only-trivy@1.0.0'},
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
            artifact: {name: 'log4j-core', version: '2.11.1', purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1?package-id=abc'},
        },
        {
            vulnerability: {
                id: 'GHSA-aaaa-bbbb-cccc',
                severity: 'Medium',
                description: 'only grype knows this one',
                dataSource: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
            },
            matchDetails: [{found: {versionConstraint: 'none (unknown)'}}],
            artifact: {name: 'minimist', version: '1.2.0', purl: 'pkg:npm/minimist@1.2.0?package-id=def'},
        },
    ],
}

describe('packageKeys', () => {
    it('indexes by stripped purl and normalized name@version, deduping through the purl', () => {
        const {keys, dedupKey} = packageKeys(
            'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1?package-id=abc', 'log4j-core', '2.11.1')
        expect(keys).toEqual([
            'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1',
            'org.apache.logging.log4j:log4j-core@2.11.1',
            'log4j-core@2.11.1',
        ])
        // NOT the bare-name key, which differs between the tools.
        expect(dedupKey).toBe('org.apache.logging.log4j:log4j-core@2.11.1')
    })

    it('falls back to name@version when there is no parseable purl', () => {
        expect(packageKeys(undefined, 'left-pad', '1.3.0'))
            .toEqual({keys: ['left-pad@1.3.0'], dedupKey: 'left-pad@1.3.0'})
    })
})

describe('trivyFindings', () => {
    it('maps one finding with ids (incl. GHSA alias), max CVSS score, timestamp and first fix version', () => {
        const [f] = trivyFindings(trivyReport)
        expect(f.ids).toEqual(['CVE-2021-44228', 'GHSA-jfh8-c2jp-5v3q'])
        expect(f.severity).toBe('CRITICAL')
        expect(f.score).toBe(10)
        expect(f.timestamp).toBe(Date.parse('2021-12-10T10:15:09.143Z'))
        expect(f.summary).toBe('log4shell')
        expect(f.firstPatchedVersion).toBe('2.15.0')
        expect(f.vulnerableRange).toBeUndefined() // Trivy reports no range against an SBOM
        expect(f.installedVersion).toBe('2.11.1')
    })

    it('uppercases severities that arrive mixed-case', () => {
        expect(trivyFindings(trivyReport)[1].severity).toBe('LOW')
    })
})

describe('grypeFindings', () => {
    it('prefers the CVSS v3 score and strips the format suffix from the constraint', () => {
        const [f] = grypeFindings(grypeReport)
        expect(f.score).toBe(10.0)
        expect(f.vulnerableRange).toBe('>=2.4,<2.12.2')
        expect(f.firstPatchedVersion).toBe('2.12.2')
    })

    it('collects the CVE id and description from relatedVulnerabilities', () => {
        const [f] = grypeFindings(grypeReport)
        expect(f.ids).toEqual(['GHSA-jfh8-c2jp-5v3q', 'CVE-2021-44228'])
        expect(f.description).toContain('JNDI features')
    })

    it('drops the placeholder "none" constraint', () => {
        expect(grypeFindings(grypeReport)[1].vulnerableRange).toBeUndefined()
    })
})

describe('buildVulnerabilityIndex — cross-tool union and merge', () => {
    const index = buildVulnerabilityIndex(trivyReport, grypeReport)

    it('dedups the same (package, CVE) finding reported by both tools', () => {
        const vulns = index.get('org.apache.logging.log4j:log4j-core@2.11.1')
        expect(vulns).toHaveLength(1)
    })

    it('merges field-level: Grype range and score, Trivy timestamp, unioned references and identifiers', () => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const v = index.get('org.apache.logging.log4j:log4j-core@2.11.1')![0]
        expect(v.vulnerableRange).toBe('>=2.4,<2.12.2')          // Grype's
        expect(v.score).toBe(10.0)                                // Grype's
        expect(v.timestamp).toBe(Date.parse('2021-12-10T10:15:09.143Z')) // Trivy's
        expect(v.severity).toBe('CRITICAL')
        expect(v.summary).toBe('log4shell')                       // only Trivy has titles
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
        expect(index.get('com.example:only-trivy@1.0.0')).toHaveLength(1)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const grypeOnly = index.get('minimist@1.2.0')!
        expect(grypeOnly).toHaveLength(1)
        expect(grypeOnly[0].description).toBe('only grype knows this one')
    })

    it('pins findings without a range to the exact installed version, so no filter can drop them', () => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(index.get('com.example:only-trivy@1.0.0')![0].vulnerableRange).toBe('=1.0.0')
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        expect(index.get('minimist@1.2.0')![0].vulnerableRange).toBe('=1.2.0')
    })

    it('also indexes by stripped purl and the tool\'s bare name@version', () => {
        expect(index.get('pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1')).toHaveLength(1)
        expect(index.get('log4j-core@2.11.1')).toHaveLength(1)
    })

    it('works with a single tool missing entirely', () => {
        const trivyOnly = buildVulnerabilityIndex(trivyReport, undefined)
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const v = trivyOnly.get('org.apache.logging.log4j:log4j-core@2.11.1')![0]
        expect(v.vulnerableRange).toBe('=2.11.1') // no Grype range -> exact-version pin
        const grypeOnly = buildVulnerabilityIndex(undefined, grypeReport)
        expect(grypeOnly.get('org.apache.logging.log4j:log4j-core@2.11.1')).toHaveLength(1)
    })
})
