import fs from 'fs'
import os from 'os'
import path from 'path'
import {GithubAdvisory} from '../src/vuln-sources/github/advisory'
import {buildAdvisoryIndex, matchComponent} from '../src/vuln-sources/github/match'
import {normalizeName, resolveEcosystems} from '../src/vuln-sources/github/ecosystems'
import {writeEcosystem} from '../src/vuln-sources/github/cache'
import {clearGithubScanCache, ecosystemsInSbom, githubScanSbomFileOnce} from '../src/vuln-sources/github/scan'

const QS: GithubAdvisory = {
    ghsa_id: 'GHSA-hrpp-h998-j3pp',
    cve_id: 'CVE-2022-24999',
    html_url: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
    summary: 'qs vulnerable to Prototype Pollution',
    description: 'qs before 6.10.3 allows prototype pollution.',
    severity: 'high',
    published_at: '2022-11-27T00:30:50Z',
    identifiers: [
        {value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'},
        {value: 'CVE-2022-24999', type: 'CVE'},
    ],
    references: ['https://nvd.nist.gov/vuln/detail/CVE-2022-24999'],
    cvss: {vector_string: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', score: 9.8},
    cwes: [{cwe_id: 'CWE-1321', name: 'Prototype Pollution'}],
    vulnerabilities: [
        // One advisory, several disjoint ranges of the same package — the real shape.
        {package: {ecosystem: 'npm', name: 'qs'}, vulnerable_version_range: '>= 6.10.0, < 6.10.3', first_patched_version: '6.10.3'},
        {package: {ecosystem: 'npm', name: 'qs'}, vulnerable_version_range: '< 6.2.4', first_patched_version: '6.2.4'},
    ],
}

const NOKOGIRI: GithubAdvisory = {
    ghsa_id: 'GHSA-2qc6-mcvw-92cw',
    // RubyGems advisories often carry no CVE and no CVSS at all.
    severity: 'moderate',
    vulnerabilities: [
        {package: {ecosystem: 'RubyGems', name: 'nokogiri'}, vulnerable_version_range: '< 1.13.9', first_patched_version: '1.13.9'},
    ],
}

const JACKSON: GithubAdvisory = {
    ghsa_id: 'GHSA-27xj-rqx5-2255',
    cve_id: 'CVE-2020-11619',
    severity: 'high',
    vulnerabilities: [
        {
            package: {ecosystem: 'Maven', name: 'com.fasterxml.jackson.core:jackson-databind'},
            vulnerable_version_range: '>= 2.9.0, < 2.9.10.4',
            first_patched_version: '2.9.10.4',
        },
    ],
}

const WITHDRAWN: GithubAdvisory = {
    ghsa_id: 'GHSA-with-draw-nnnn',
    severity: 'critical',
    withdrawn_at: '2023-01-01T00:00:00Z',
    vulnerabilities: [{package: {ecosystem: 'npm', name: 'qs'}, vulnerable_version_range: '< 99.0.0'}],
}

const ALL_VERSIONS: GithubAdvisory = {
    ghsa_id: 'GHSA-allv-ersi-onss',
    severity: 'low',
    // No range at all: the publisher says every version is affected.
    vulnerabilities: [{package: {ecosystem: 'pip', name: 'Flask_Bad.Name'}}],
}

describe('normalizeName', () => {
    it('applies PEP 503 to pip and nothing lossy elsewhere', () => {
        expect(normalizeName('pip', 'Flask_Bad.Name')).toBe('flask-bad-name')
        expect(normalizeName('pip', 'flask-bad-name')).toBe('flask-bad-name')
        expect(normalizeName('maven', 'com.fasterxml/jackson-databind')).toBe('com.fasterxml:jackson-databind')
        expect(normalizeName('maven', 'com.fasterxml:jackson-databind')).toBe('com.fasterxml:jackson-databind')
        expect(normalizeName('npm', '@scope/Name')).toBe('@scope/name')
        expect(normalizeName('nuget', 'Newtonsoft.Json')).toBe('newtonsoft.json')
    })
})

describe('resolveEcosystems', () => {
    it('accepts either the GitHub or the purl spelling of the same ecosystem', () => {
        expect(resolveEcosystems(['gem', 'rubygems']).resolved.map(it => it.name)).toEqual(['rubygems'])
        expect(resolveEcosystems(['pypi']).resolved.map(it => it.name)).toEqual(['pip'])
        expect(resolveEcosystems(['golang', 'cargo']).resolved.map(it => it.name)).toEqual(['go', 'rust'])
        expect(resolveEcosystems(['nonsense']).unknown).toEqual(['nonsense'])
    })
})

describe('matchComponent', () => {
    const index = buildAdvisoryIndex([QS, NOKOGIRI, JACKSON, WITHDRAWN, ALL_VERSIONS])

    it('matches only the versions inside a range', () => {
        expect(matchComponent(index, 'npm', 'qs', '6.10.2').map(it => it.identifiers?.[0].value))
            .toEqual(['GHSA-hrpp-h998-j3pp'])
        expect(matchComponent(index, 'npm', 'qs', '6.10.3')).toEqual([])
        // The advisory's other disjoint range.
        expect(matchComponent(index, 'npm', 'qs', '6.2.3')).toHaveLength(1)
    })

    it('reports one advisory once, however many of its ranges name the package', () => {
        expect(matchComponent(index, 'npm', 'qs', '6.10.2')).toHaveLength(1)
    })

    it('returns the same finding model local-scan produces', () => {
        const [finding] = matchComponent(index, 'npm', 'qs', '6.10.2')
        expect(finding).toMatchObject({
            severity: 'HIGH',
            score: 9.8,
            cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
            cvssVersion: '3.1',
            cweIds: ['CWE-1321'],
            firstPatchedVersion: '6.10.3',
            vulnerableRange: '>= 6.10.0, < 6.10.3',
            source: 'github',
            permalink: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
        })
        expect(finding.identifiers).toEqual([
            {value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'},
            {value: 'CVE-2022-24999', type: 'CVE'},
        ])
        expect(finding.timestamp).toBe(Date.parse('2022-11-27T00:30:50Z'))
    })

    it('maps GitHub MODERATE to the MEDIUM band every other source uses', () => {
        expect(matchComponent(index, 'gem', 'nokogiri', '1.13.8')[0].severity).toBe('MEDIUM')
    })

    it('accepts the purl type as well as the GitHub ecosystem name', () => {
        expect(matchComponent(index, 'rubygems', 'nokogiri', '1.13.8')).toHaveLength(1)
        expect(matchComponent(index, 'gem', 'nokogiri', '1.13.8')).toHaveLength(1)
    })

    it('matches maven by group:artifact with the generic comparator', () => {
        expect(matchComponent(index, 'maven', 'com.fasterxml.jackson.core:jackson-databind', '2.9.10.3')).toHaveLength(1)
        expect(matchComponent(index, 'maven', 'com.fasterxml.jackson.core:jackson-databind', '2.9.10.4')).toEqual([])
    })

    it('normalises the SBOM name as well as the advisory name', () => {
        expect(matchComponent(index, 'pypi', 'flask-bad-name', '1.0')).toHaveLength(1)
        expect(matchComponent(index, 'pypi', 'Flask.Bad_Name', '99.0')).toHaveLength(1)
    })

    it('drops withdrawn advisories', () => {
        expect(matchComponent(index, 'npm', 'qs', '1.0.0').map(it => it.identifiers?.[0].value))
            .toEqual(['GHSA-hrpp-h998-j3pp'])
    })

    it('is empty for an ecosystem or package it has never heard of', () => {
        expect(matchComponent(index, 'conan', 'redis', '1.0')).toEqual([])
        expect(matchComponent(index, 'npm', 'not-a-package', '1.0')).toEqual([])
    })
})

describe('scanning an SBOM against the cache', () => {
    let dir: string
    let sbom: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-gh-scan-'))
        sbom = path.join(dir, 'project.cdx.json')
        fs.writeFileSync(sbom, JSON.stringify({
            components: [
                {'bom-ref': '1', name: 'qs', version: '6.10.2', purl: 'pkg:npm/qs@6.10.2'},
                {'bom-ref': '2', name: 'qs', version: '6.10.3', purl: 'pkg:npm/qs@6.10.3'},
                {'bom-ref': '3', name: 'nokogiri', version: '1.13.8', purl: 'pkg:gem/nokogiri@1.13.8'},
                {'bom-ref': '4', name: 'ripgrep', version: '13.0.0', purl: 'pkg:cargo/ripgrep@13.0.0'},
            ],
        }))
        clearGithubScanCache()
    })

    afterEach(() => {
        clearGithubScanCache()
        fs.rmSync(dir, {recursive: true, force: true})
    })

    it('derives the ecosystems an SBOM needs from its purl types', () => {
        expect(ecosystemsInSbom(sbom)).toEqual(['npm', 'rubygems', 'rust'])
    })

    it('indexes findings under the key the sbom parser looks up', () => {
        writeEcosystem(dir, 'npm', [QS], {downloadedAt: new Date().toISOString()})
        writeEcosystem(dir, 'rubygems', [NOKOGIRI], {downloadedAt: new Date().toISOString()})

        const result = githubScanSbomFileOnce(sbom, dir)
        expect(result.available).toBe(true)
        expect(result.index.get('qs@6.10.2')).toHaveLength(1)
        expect(result.index.get('qs@6.10.3')).toBeUndefined()
        expect(result.index.get('nokogiri@1.13.8')).toHaveLength(1)
        // The purl form is indexed too, as local-scan does.
        expect(result.index.get('pkg:npm/qs@6.10.2')).toHaveLength(1)
        // cargo has no cache written, so it is reported as missing rather than as "clean".
        expect(result.missingEcosystems).toEqual(['rust'])
    })

    it('is unavailable, not empty-but-confident, when nothing is cached', () => {
        const result = githubScanSbomFileOnce(sbom, dir)
        expect(result.available).toBe(false)
        expect(result.index.size).toBe(0)
        expect(result.missingEcosystems.sort()).toEqual(['npm', 'rubygems', 'rust'])
    })
})
