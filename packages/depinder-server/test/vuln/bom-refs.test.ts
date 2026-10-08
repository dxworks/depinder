import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {buildVulnerabilityIndex, PINNED_SCANNER_VERSIONS, type GrypeReport} from '@depinder/core'
import {bomRefKeyer} from '../../src/vuln/bom-refs.js'

// The merge itself is tested in core; this is how the server ties findings to the purls it was sent.

const TOML = 'pkg:golang/github.com/BurntSushi/toml@v0.3.1'

describe('bomRefKeyer', () => {
    it('lands a Trivy finding on the mixed-case purl that was sent, whatever Trivy calls the package', () => {
        // Trivy lowercases a golang path in both PkgName and PURL; only the ref is ours.
        const {index} = buildVulnerabilityIndex({Results: [{Vulnerabilities: [{
            VulnerabilityID: 'CVE-2099-1',
            PkgName: 'github.com/burntsushi/toml',
            InstalledVersion: 'v0.3.1',
            PkgIdentifier: {PURL: 'pkg:golang/github.com/burntsushi/toml@v0.3.1', BOMRef: 'c0'},
        }]}]}, undefined, bomRefKeyer(new Map([['c0', TOML]])))
        expect([...index.keys()]).toEqual([TOML])
    })

    it('falls back to the exact artifact.purl when Grype\'s artifact.id is not one of ours', () => {
        const report: GrypeReport = {matches: [{
            vulnerability: {id: 'GHSA-xxxx-yyyy-zzzz'},
            artifact: {id: '6f2a9c01d', name: 'toml', version: 'v0.3.1', purl: 'pkg:golang/github.com/BurntSushi/toml@v0.3.1'},
        }]}
        const sent = `${TOML}?vcs_url=x`
        const {index, unmapped} = buildVulnerabilityIndex(undefined, report, bomRefKeyer(new Map([['c0', sent]]), new Map([[TOML, 'c0']])))
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
            bomRefKeyer(new Map([['c0', TOML]]), new Map([[TOML, 'c0']])),
        )
        expect(unmapped).toBe(3)
        expect([...index.keys()]).toEqual([TOML])
        expect(index.get(TOML)!.map(v => v.identifiers![0]!.value)).toEqual(['CVE-2099-3'])
    })

    it('keeps the same CVE apart on two refs, even for two spellings of one package', () => {
        const same = (ref: string) => ({VulnerabilityID: 'CVE-2099-1', PkgIdentifier: {BOMRef: ref}})
        const {index} = buildVulnerabilityIndex(
            {Results: [{Vulnerabilities: [same('c0'), same('c1')]}]}, undefined,
            bomRefKeyer(new Map([['c0', 'pkg:npm/a@1'], ['c1', 'pkg:npm/a@1?x=y']])),
        )
        expect(index.get('pkg:npm/a@1')).toHaveLength(1)
        expect(index.get('pkg:npm/a@1?x=y')).toHaveLength(1)
    })
})

describe('the image\'s scanners', () => {
    it('are the versions core pins', () => {
        const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
        expect(dockerfile).toContain(`FROM aquasec/trivy:${PINNED_SCANNER_VERSIONS.trivy}@`)
        expect(dockerfile).toContain(`FROM anchore/grype:v${PINNED_SCANNER_VERSIONS.grype}@`)
    })
})
