import {buildVulnerabilityIndex, type GrypeReport, type TrivyReport} from '@depinder/core'
import {packageKeys, sbomPackageKeyer} from '../src/plugins/sbom/package-keys'

/**
 * How a local scan ties findings to a real SBOM's packages (the merge itself is tested in core).
 * Trivy names a maven package `group:artifact`; Grype gives the BARE artifactId, and Syft purls
 * carry a `package-id` qualifier. Both tools' findings must still dedup through the purl.
 */

const LOG4J = 'pkg:maven/org.apache.logging.log4j/log4j-core@2.11.1'

const trivyReport: TrivyReport = {
    Results: [{
        Vulnerabilities: [
            {
                VulnerabilityID: 'CVE-2021-44228',
                VendorIDs: ['GHSA-jfh8-c2jp-5v3q'],
                PkgName: 'org.apache.logging.log4j:log4j-core',
                InstalledVersion: '2.11.1',
                PkgIdentifier: {PURL: LOG4J},
                PublishedDate: '2021-12-10T10:15:09.143Z',
            },
            {
                VulnerabilityID: 'CVE-2020-0001',
                PkgName: 'com.example:only-trivy',
                InstalledVersion: '1.0.0',
                PkgIdentifier: {PURL: 'pkg:maven/com.example/only-trivy@1.0.0'},
            },
        ],
    }],
}

const grypeReport: GrypeReport = {
    matches: [
        {
            vulnerability: {id: 'GHSA-jfh8-c2jp-5v3q'},
            relatedVulnerabilities: [{id: 'CVE-2021-44228'}],
            matchDetails: [{found: {versionConstraint: '>=2.4,<2.12.2 (unknown)'}}],
            artifact: {name: 'log4j-core', version: '2.11.1', purl: `${LOG4J}?package-id=abc`},
        },
        {
            vulnerability: {id: 'GHSA-aaaa-bbbb-cccc'},
            artifact: {name: 'minimist', version: '1.2.0', purl: 'pkg:npm/minimist@1.2.0?package-id=def'},
        },
    ],
}

describe('packageKeys', () => {
    it('indexes by stripped purl and normalized name@version, deduping through the purl', () => {
        const {keys, dedupKey} = packageKeys(`${LOG4J}?package-id=abc`, 'log4j-core', '2.11.1')
        expect(keys).toEqual([
            LOG4J,
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

describe('sbomPackageKeyer', () => {
    const {index} = buildVulnerabilityIndex(trivyReport, grypeReport, sbomPackageKeyer)

    it('dedups the same (package, CVE) finding across the tools\' different package names', () => {
        const [v] = index.get('org.apache.logging.log4j:log4j-core@2.11.1')!
        expect(index.get('org.apache.logging.log4j:log4j-core@2.11.1')).toHaveLength(1)
        expect(v.source).toBe('trivy,grype')
    })

    it('indexes a finding by stripped purl, registrar name@version and each tool\'s own name@version', () => {
        const [v] = index.get('org.apache.logging.log4j:log4j-core@2.11.1')!
        expect(index.get(LOG4J)).toEqual([v])
        expect(index.get('log4j-core@2.11.1')).toEqual([v])
    })

    it('keeps single-tool findings under their registrar keys', () => {
        expect(index.get('com.example:only-trivy@1.0.0')).toHaveLength(1)
        expect(index.get('minimist@1.2.0')).toHaveLength(1)
    })

    it('drops a finding with no purl, name or version', () => {
        expect(sbomPackageKeyer({})).toBeUndefined()
    })
})
