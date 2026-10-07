import fs from 'fs'
import os from 'os'
import path from 'path'
import {clearSbomDescriptions, describeSbom, producerOf, purlTypesOf} from '../src/plugins/sbom/describe'
import {metadataProjectName, projectNameOf, repoNameFromFile} from '../src/plugins/sbom/cyclonedx'

/**
 * `analyse` sorts SBOMs by what they say about themselves, never by file name or folder: which
 * tool wrote them, which repository they describe, which ecosystems they hold. These are the
 * shapes real Trivy and Syft output uses, plus the older CycloneDX 1.4 tools array.
 */

let tmpDir: string

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-describe-'))
})

afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

beforeEach(() => clearSbomDescriptions())

function write(name: string, bom: unknown): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, typeof bom === 'string' ? bom : JSON.stringify(bom))
    return file
}

const trivyTools = {components: [{type: 'application', group: 'aquasecurity', name: 'trivy', version: '0.72.0'}]}
const syftTools = {components: [{type: 'application', author: 'anchore', name: 'syft', version: '1.46.0'}]}

describe('the producer', () => {
    it('is read from the CycloneDX 1.5 tools.components list', () => {
        expect(producerOf({metadata: {tools: trivyTools}})).toEqual({producer: 'trivy', toolVersion: '0.72.0'})
        expect(producerOf({metadata: {tools: syftTools}})).toEqual({producer: 'syft', toolVersion: '1.46.0'})
    })

    it('is read from the CycloneDX 1.4 tools array', () => {
        expect(producerOf({metadata: {tools: [{vendor: 'anchore', name: 'syft', version: '0.90.0'}]}}))
            .toEqual({producer: 'syft', toolVersion: '0.90.0'})
    })

    it('names any other tool, lowercased, and is unknown when none is listed', () => {
        expect(producerOf({metadata: {tools: {components: [{name: 'CycloneDX Generator', version: '10.0'}]}}}))
            .toEqual({producer: 'cyclonedx-generator', toolVersion: '10.0'})
        expect(producerOf({metadata: {}})).toEqual({producer: 'unknown'})
        expect(producerOf({})).toEqual({producer: 'unknown'})
    })
})

describe('the repository name', () => {
    it('is the metadata component name', () => {
        const bom = {metadata: {component: {'bom-ref': 'r', type: 'application', name: 'go-caddy'}}}
        expect(metadataProjectName(bom)).toBe('go-caddy')
        expect(projectNameOf(bom, '/x/anything.cdx.json')).toBe('go-caddy')
    })

    it('falls back to the file name when the metadata carries a path, a dot or nothing', () => {
        const file = '/x/ruby-mastodon.trivy.cdx.json'
        expect(repoNameFromFile(file)).toBe('ruby-mastodon')
        expect(repoNameFromFile('/x/ruby-mastodon.cdx.json')).toBe('ruby-mastodon')
        for (const name of ['/abs/path/to/repo', 'C:\\repo', '.', '..', '', '  ', undefined]) {
            expect(projectNameOf({metadata: {component: {'bom-ref': 'r', name}}}, file)).toBe('ruby-mastodon')
        }
        expect(projectNameOf({}, file)).toBe('ruby-mastodon')
    })
})

describe('the purl types', () => {
    it('are read out of the components', () => {
        expect([...purlTypesOf({components: [
            {'bom-ref': 'a', purl: 'pkg:gem/nokogiri@1.13.8'},
            {'bom-ref': 'b', purl: 'pkg:npm/qs@6.10.2'},
            {'bom-ref': 'c', purl: 'pkg:golang/golang.org/x/crypto@v0.54.0'},
            {'bom-ref': 'no-purl'},
        ]})].sort()).toEqual(['gem', 'golang', 'npm'])
    })
})

describe('describeSbom', () => {
    it('describes a Trivy SBOM from its content, whatever the file is called', () => {
        const file = write('anything.cdx.json', {
            bomFormat: 'CycloneDX', specVersion: '1.7',
            metadata: {tools: trivyTools, component: {'bom-ref': 'r', type: 'application', name: 'go-caddy'}},
            components: [{'bom-ref': 'a', purl: 'pkg:golang/github.com/x/y@v1.0.0'}],
        })
        expect(describeSbom(file)).toEqual({
            file, producer: 'trivy', toolVersion: '0.72.0', repo: 'go-caddy', repoFromMetadata: true,
            purlTypes: new Set(['golang']), specVersion: '1.7',
        })
    })

    it('says when the repository name had to come from the file name', () => {
        const file = write('ruby-mastodon.cdx.json', {
            bomFormat: 'CycloneDX', metadata: {tools: syftTools, component: {'bom-ref': 'r', type: 'file', name: '/scans/x'}},
            components: [],
        })
        expect(describeSbom(file)).toMatchObject({producer: 'syft', repo: 'ruby-mastodon', repoFromMetadata: false})
    })

    it('rejects a file that is not a CycloneDX BOM', () => {
        expect(() => describeSbom(write('broken.cdx.json', '{ not json'))).toThrow()
        expect(() => describeSbom(write('spdx.cdx.json', {spdxVersion: 'SPDX-2.3', packages: []}))).toThrow(/not a CycloneDX/)
        expect(() => describeSbom(write('other.cdx.json', {bomFormat: 'Other', components: []}))).toThrow(/not a CycloneDX/)
    })

    it('reads each file once until the memo is cleared', () => {
        const file = write('memo.cdx.json', {bomFormat: 'CycloneDX', metadata: {tools: trivyTools}, components: []})
        const first = describeSbom(file)
        fs.writeFileSync(file, JSON.stringify({bomFormat: 'CycloneDX', metadata: {tools: syftTools}, components: []}))
        expect(describeSbom(file)).toBe(first)
        clearSbomDescriptions()
        expect(describeSbom(file).producer).toBe('syft')
    })
})
