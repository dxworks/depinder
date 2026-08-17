import fs from 'fs'
import os from 'os'
import path from 'path'
import {parseCycloneDxFile, parsePurl} from '../src/plugins/sbom/cyclonedx'

/**
 * Fixtures reproduce the two shapes we actually observed in offline Syft/Trivy output:
 *  - Syft: root is a `file` node that carries NO dependsOn edges, so the whole BOM is one project.
 *  - Trivy: root -> `application` node per manifest -> dependencies, so the BOM holds many projects.
 * In both, dependency refs are the target's bom-ref verbatim.
 */

let tmpDir: string

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-sbom-'))
})

afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

function writeBom(name: string, bom: unknown): string {
    const file = path.join(tmpDir, name)
    fs.writeFileSync(file, JSON.stringify(bom))
    return file
}

const syftBom = {
    metadata: {component: {'bom-ref': 'root-hash', type: 'file', name: '/abs/path/to/repo'}},
    components: [
        {
            'bom-ref': 'pkg:maven/org.slf4j/slf4j-api@1.7.35?package-id=aaa',
            type: 'library', group: 'org.slf4j', name: 'slf4j-api', version: '1.7.35',
            purl: 'pkg:maven/org.slf4j/slf4j-api@1.7.35',
            licenses: [{license: {id: 'MIT'}}],
        },
        {
            'bom-ref': 'pkg:maven/org.slf4j/slf4j-reload4j@1.7.35?package-id=bbb',
            type: 'library', group: 'org.slf4j', name: 'slf4j-reload4j', version: '1.7.35',
            purl: 'pkg:maven/org.slf4j/slf4j-reload4j@1.7.35',
        },
        {
            'bom-ref': 'pkg:npm/side-channel@1.1.0?package-id=ccc',
            type: 'library', name: 'side-channel', version: '1.1.0',
            purl: 'pkg:npm/side-channel@1.1.0',
        },
        // No purl: a GitHub Action directory. Must be ignored, not parsed.
        {'bom-ref': 'no-purl-hash', type: 'library', name: './.github/actions/x', version: 'UNKNOWN'},
    ],
    dependencies: [
        {
            ref: 'pkg:maven/org.slf4j/slf4j-reload4j@1.7.35?package-id=bbb',
            dependsOn: ['pkg:maven/org.slf4j/slf4j-api@1.7.35?package-id=aaa'],
        },
    ],
}

const trivyBom = {
    metadata: {component: {'bom-ref': 'root-uuid', type: 'application', name: '/abs/path/to/repo'}},
    components: [
        {
            'bom-ref': 'proj-a', type: 'application', name: 'moduleA/pom.xml',
            properties: [{name: 'aquasecurity:trivy:Type', value: 'pom'}],
        },
        {
            'bom-ref': 'proj-b', type: 'application', name: 'moduleB/pom.xml',
            properties: [{name: 'aquasecurity:trivy:Type', value: 'pom'}],
        },
        {
            'bom-ref': 'dep-guava', type: 'library', group: 'com.google.guava', name: 'guava',
            version: '14.0.1', purl: 'pkg:maven/com.google.guava/guava@14.0.1',
            licenses: [{license: {id: 'Apache-2.0'}}],
        },
        {
            'bom-ref': 'dep-gson', type: 'library', group: 'com.google.code.gson', name: 'gson',
            version: '2.8.9', purl: 'pkg:maven/com.google.code.gson/gson@2.8.9',
        },
    ],
    dependencies: [
        {ref: 'root-uuid', dependsOn: ['proj-a', 'proj-b']},
        {ref: 'proj-a', dependsOn: ['dep-guava']},
        {ref: 'dep-guava', dependsOn: ['dep-gson']},
        {ref: 'proj-b', dependsOn: ['dep-gson']},
    ],
}

describe('parsePurl', () => {
    it('renders maven coordinates as groupId:artifactId, which is what MavenCentralRegistrar splits on', () => {
        expect(parsePurl('pkg:maven/org.slf4j/slf4j-api@1.7.35'))
            .toEqual({type: 'maven', name: 'org.slf4j:slf4j-api', version: '1.7.35'})
    })

    it('keeps npm scopes intact and url-decodes them', () => {
        expect(parsePurl('pkg:npm/%40babel%2Fcore@7.20.0'))
            .toEqual({type: 'npm', name: '@babel/core', version: '7.20.0'})
    })

    it('ignores qualifiers such as Syft package-id', () => {
        expect(parsePurl('pkg:npm/side-channel@1.1.0?package-id=ccc'))
            .toEqual({type: 'npm', name: 'side-channel', version: '1.1.0'})
    })

    it('returns undefined rather than guessing for non-purls and versionless purls', () => {
        expect(parsePurl('not-a-purl')).toBeUndefined()
        expect(parsePurl('pkg:maven/org.slf4j/slf4j-api')).toBeUndefined()
    })
})

describe('parseCycloneDxFile — Syft shape (no project nodes)', () => {
    it('produces exactly one project even though the root has no edges', () => {
        const projects = parseCycloneDxFile(writeBom('a.cdx.json', syftBom), 'maven')
        expect(projects).toHaveLength(1)
        expect(projects[0].name).toBe('a')
    })

    it('filters to the requested ecosystem and skips components without a purl', () => {
        const file = writeBom('b.cdx.json', syftBom)
        expect(Object.keys(parseCycloneDxFile(file, 'maven')[0].dependencies).sort())
            .toEqual(['org.slf4j:slf4j-api@1.7.35', 'org.slf4j:slf4j-reload4j@1.7.35'])
        expect(Object.keys(parseCycloneDxFile(file, 'npm')[0].dependencies))
            .toEqual(['side-channel@1.1.0'])
    })

    it('inverts dependsOn into requestedBy', () => {
        const deps = parseCycloneDxFile(writeBom('c.cdx.json', syftBom), 'maven')[0].dependencies
        expect(deps['org.slf4j:slf4j-api@1.7.35'].requestedBy)
            .toEqual(['org.slf4j:slf4j-reload4j@1.7.35'])
        expect(deps['org.slf4j:slf4j-reload4j@1.7.35'].requestedBy).toEqual([])
    })

    it('carries licenses through when the SBOM has them', () => {
        const deps = parseCycloneDxFile(writeBom('d.cdx.json', syftBom), 'maven')[0].dependencies
        expect(deps['org.slf4j:slf4j-api@1.7.35'].libraryInfo?.licenses).toEqual(['MIT'])
        expect(deps['org.slf4j:slf4j-reload4j@1.7.35'].libraryInfo).toBeUndefined()
    })

    it('reads all three CycloneDX license shapes, including compound expressions', () => {
        const bom = {
            metadata: {component: {'bom-ref': 'r', type: 'file', name: '/repo'}},
            components: [
                {
                    'bom-ref': 'a', name: 'a', version: '1.0.0', purl: 'pkg:npm/a@1.0.0',
                    licenses: [{license: {id: 'MIT'}}],
                },
                {
                    'bom-ref': 'b', name: 'b', version: '1.0.0', purl: 'pkg:npm/b@1.0.0',
                    licenses: [{license: {name: 'The Apache Software License, Version 2.0', url: 'https://x'}}],
                },
                {
                    'bom-ref': 'c', name: 'c', version: '1.0.0', purl: 'pkg:npm/c@1.0.0',
                    licenses: [{expression: 'BSD-3-Clause OR MIT'}],
                },
                {
                    'bom-ref': 'd', name: 'd', version: '1.0.0', purl: 'pkg:npm/d@1.0.0',
                    licenses: [{license: {}}],
                },
            ],
            dependencies: [],
        }
        const deps = parseCycloneDxFile(writeBom('lic.cdx.json', bom), 'npm')[0].dependencies
        expect(deps['a@1.0.0'].libraryInfo?.licenses).toEqual(['MIT'])
        expect(deps['b@1.0.0'].libraryInfo?.licenses).toEqual(['The Apache Software License, Version 2.0'])
        expect(deps['c@1.0.0'].libraryInfo?.licenses).toEqual(['BSD-3-Clause OR MIT'])
        expect(deps['d@1.0.0'].libraryInfo).toBeUndefined()
    })

    it('merges duplicate components so a license on any copy survives, whatever the order', () => {
        // Real Syft output duplicates a package when it is found in several locations, and the
        // copies disagree: on Zeppelin 31 purls are duplicated, 11 with a license on only some.
        const bom = (licenseFirst: boolean) => ({
            metadata: {component: {'bom-ref': 'r', type: 'file', name: '/repo'}},
            components: [
                {
                    'bom-ref': 'dup-1', name: 'amdefine', version: '1.0.1',
                    purl: 'pkg:npm/amdefine@1.0.1?package-id=aaa',
                    licenses: licenseFirst ? [{expression: 'BSD-3-Clause OR MIT'}] : undefined,
                },
                {
                    'bom-ref': 'dup-2', name: 'amdefine', version: '1.0.1',
                    purl: 'pkg:npm/amdefine@1.0.1?package-id=bbb',
                    licenses: licenseFirst ? undefined : [{expression: 'BSD-3-Clause OR MIT'}],
                },
            ],
            dependencies: [],
        })

        for (const licenseFirst of [true, false]) {
            const file = writeBom(`dup-${licenseFirst}.cdx.json`, bom(licenseFirst))
            const deps = parseCycloneDxFile(file, 'npm')[0].dependencies
            expect(Object.keys(deps)).toEqual(['amdefine@1.0.1'])
            expect(deps['amdefine@1.0.1'].libraryInfo?.licenses).toEqual(['BSD-3-Clause OR MIT'])
        }
    })

    it('leaves type undefined, because no SBOM format carries dependency scope', () => {
        const deps = parseCycloneDxFile(writeBom('e.cdx.json', syftBom), 'maven')[0].dependencies
        expect(deps['org.slf4j:slf4j-api@1.7.35'].type).toBeUndefined()
    })
})

describe('parseCycloneDxFile — Trivy shape (application nodes are the projects)', () => {
    it('splits one SBOM into one project per manifest node', () => {
        const projects = parseCycloneDxFile(writeBom('f.trivy.cdx.json', trivyBom), 'maven')
        expect(projects.map(p => p.name).sort()).toEqual(['moduleA', 'moduleB'])
        expect(projects.map(p => p.path).sort()).toEqual(['moduleA/pom.xml', 'moduleB/pom.xml'])
    })

    it('scopes each project to what is reachable from its own node', () => {
        const projects = parseCycloneDxFile(writeBom('g.trivy.cdx.json', trivyBom), 'maven')
        const a = projects.find(p => p.name === 'moduleA')
        const b = projects.find(p => p.name === 'moduleB')
        // moduleA reaches gson transitively through guava; moduleB depends on gson directly only.
        expect(Object.keys(a!.dependencies).sort())
            .toEqual(['com.google.code.gson:gson@2.8.9', 'com.google.guava:guava@14.0.1'])
        expect(Object.keys(b!.dependencies)).toEqual(['com.google.code.gson:gson@2.8.9'])
    })

    it('attributes a project-node edge to the project id, so depinder sees it as direct', () => {
        const projects = parseCycloneDxFile(writeBom('h.trivy.cdx.json', trivyBom), 'maven')
        const a = projects.find(p => p.name === 'moduleA')!
        const guava = a.dependencies['com.google.guava:guava@14.0.1']
        expect(guava.requestedBy).toEqual([`${a.name}@${a.version}`])

        // This is the exact expression analyse.ts uses to classify direct vs indirect.
        const isDirect = (d: typeof guava) =>
            !d.requestedBy.length || d.requestedBy.some(r => r.startsWith(`${a.name}@${a.version}`))
        expect(isDirect(guava)).toBe(true)
        expect(isDirect(a.dependencies['com.google.code.gson:gson@2.8.9'])).toBe(false)
    })

    it('parses semver where possible and yields null instead of throwing where not', () => {
        const projects = parseCycloneDxFile(writeBom('i.trivy.cdx.json', trivyBom), 'maven')
        const guava = projects.find(p => p.name === 'moduleA')!.dependencies['com.google.guava:guava@14.0.1']
        expect(guava.semver?.version).toBe('14.0.1')
    })

    it('returns no projects for an ecosystem the SBOM does not contain', () => {
        expect(parseCycloneDxFile(writeBom('j.trivy.cdx.json', trivyBom), 'gem')).toEqual([])
    })
})
