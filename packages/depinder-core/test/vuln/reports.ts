import type {GrypeReport, TrivyReport} from '../../src/index.js'

/**
 * Report shapes measured in real Trivy / Grype output:
 *  - Trivy names a maven package `group:artifact` and carries the GHSA alias in `VendorIDs`; it
 *    knows PublishedDate but no vulnerable range.
 *  - Grype names it by the BARE artifactId, uses the GHSA id as primary with the CVE in
 *    `relatedVulnerabilities`, and suffixes constraints with a format marker.
 * Both echo the SBOM component's bom-ref (`c0`..`c2`) and its purl.
 */

export const LOG4J = 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1'
export const ONLY_TRIVY = 'pkg:maven/com.example/only-trivy@1.0.0'
export const MINIMIST = 'pkg:npm/minimist@1.2.0'

export const trivyReport: TrivyReport = {
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

export const grypeReport: GrypeReport = {
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
