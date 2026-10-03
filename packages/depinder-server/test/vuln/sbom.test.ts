import {describe, expect, it} from 'vitest'
import {parseVulnRequest} from '../../src/vuln/request.js'
import {buildSbom} from '../../src/vuln/sbom.js'

interface Component {
    'bom-ref': string
    type: string
    name: string
    group?: string
    version: string
    purl: string
}

function components(purls: string[]): Component[] {
    const {scan} = parseVulnRequest({purls}, 100)
    return (JSON.parse(buildSbom(scan)) as {components: Component[]}).components
}

describe('buildSbom', () => {
    it('writes a CycloneDX 1.6 document around a root application', () => {
        const bom = JSON.parse(buildSbom([])) as Record<string, unknown>
        expect(bom).toMatchObject({
            bomFormat: 'CycloneDX',
            specVersion: '1.6',
            version: 1,
            metadata: {component: {'bom-ref': 'root', type: 'application', name: 'purl-batch'}},
            components: [],
        })
        expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    })

    it('names each ecosystem the way Trivy\'s own SBOMs do', () => {
        const got = components([
            'pkg:maven/org.yaml/snakeyaml@1.33',
            'pkg:npm/%40nestjs/core@10.0.0',
            'pkg:npm/lodash@4.17.21',
            'pkg:composer/symfony/http-foundation@v7.3.2',
            'pkg:golang/github.com/BurntSushi/toml@v1.3.2',
            'pkg:cargo/serde@1.0.0',
            'pkg:gem/rails@7.0.0',
            'pkg:nuget/Newtonsoft.Json@13.0.1',
            'pkg:pypi/Django_Rest.Framework@3.0',
        ])
        expect(got.map(c => [c.group, c.name, c.version])).toEqual([
            ['org.yaml', 'snakeyaml', '1.33'],
            // `%40` decoded.
            ['@nestjs', 'core', '10.0.0'],
            [undefined, 'lodash', '4.17.21'],
            [undefined, 'symfony/http-foundation', 'v7.3.2'],
            // Mixed case kept: a golang module path is case-sensitive.
            [undefined, 'github.com/BurntSushi/toml', 'v1.3.2'],
            [undefined, 'serde', '1.0.0'],
            [undefined, 'rails', '7.0.0'],
            [undefined, 'Newtonsoft.Json', '13.0.1'],
            // Not PEP 503-normalised.
            [undefined, 'Django_Rest.Framework', '3.0'],
        ])
        expect(got.every(c => c.type === 'library')).toBe(true)
        expect(got.some(c => 'group' in c && c.group === undefined)).toBe(false)
    })

    it('refs components c0.. in scan order, with the purl stripped of qualifiers and subpath', () => {
        const got = components(['pkg:npm/b@2?x=1#y', 'not a purl', 'pkg:npm/a@1'])
        expect(got.map(c => [c['bom-ref'], c.purl])).toEqual([
            ['c0', 'pkg:npm/b@2'],
            ['c1', 'pkg:npm/a@1'],
        ])
    })

    it('decodes the version', () => {
        expect(components(['pkg:npm/a@1.0.0%2Bbuild'])[0]!.version).toBe('1.0.0+build')
    })
})
