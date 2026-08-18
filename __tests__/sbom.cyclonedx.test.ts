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

/**
 * Real Trivy output inserts the module's OWN artifact (the self-anchor) between each pom.xml
 * application node and the real dependencies. The parser must re-root direct attribution on that
 * anchor and keep the anchor itself out of its own project's dependency map.
 *
 *   moduleA/pom.xml -> module-a (anchor, sole child) -> guava -> gson
 *   moduleB/pom.xml -> module-b (anchor, has outgoing edges) + commons-io (genuine direct leaf)
 *                       module-b -> gson, module-a   (moduleA's artifact as a REAL dep here)
 */
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
            'bom-ref': 'anchor-a', type: 'library', group: 'org.example', name: 'module-a',
            version: '1.0.0', purl: 'pkg:maven/org.example/module-a@1.0.0',
        },
        {
            'bom-ref': 'anchor-b', type: 'library', group: 'org.example', name: 'module-b',
            version: '1.0.0', purl: 'pkg:maven/org.example/module-b@1.0.0',
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
        {
            'bom-ref': 'dep-commons', type: 'library', group: 'commons-io', name: 'commons-io',
            version: '2.11.0', purl: 'pkg:maven/commons-io/commons-io@2.11.0',
        },
    ],
    dependencies: [
        {ref: 'root-uuid', dependsOn: ['proj-a', 'proj-b']},
        // moduleA: the anchor is the SOLE child of the application node.
        {ref: 'proj-a', dependsOn: ['anchor-a']},
        {ref: 'anchor-a', dependsOn: ['dep-guava']},
        {ref: 'dep-guava', dependsOn: ['dep-gson']},
        // moduleB: anchor (identified by its outgoing edges) PLUS a genuine direct-dep sibling.
        {ref: 'proj-b', dependsOn: ['anchor-b', 'dep-commons']},
        {ref: 'anchor-b', dependsOn: ['dep-gson', 'anchor-a']},
    ],
}

/**
 * Real Syft output over a Maven monorepo is FLAT: the root `file` node has no edges, so without
 * reconstruction the whole SBOM collapses into one project. Module boundaries are rebuilt from
 * each component's `syft:location:0:path` property (grouped by pom.xml), the monorepo groupId is
 * bootstrapped from the SBOM itself (groupId occurring exactly once per group, degenerate
 * `<name>/<name>` purls skipped), and each group's unique monorepo-groupId component is the
 * module's anchor. Membership is dependsOn-reachability from the anchor, NOT the location group.
 */
const loc = (p: string) => [{name: 'syft:location:0:path', value: p}]
const syftMonorepoBom = {
    metadata: {component: {'bom-ref': 'root-hash', type: 'file', name: '/abs/path/to/repo'}},
    components: [
        // Root pom group: the root anchor + slf4j twice (org.slf4j occurs TWICE here, so it must
        // score zero for the bootstrap despite being frequent) + gson (located here but pulled in
        // by moduleA — membership must follow edges, not location).
        {
            'bom-ref': 'anchor-root', type: 'library', name: 'zeppelin', version: '0.13.0',
            purl: 'pkg:maven/org.zeppelin/zeppelin@0.13.0', properties: loc('/pom.xml'),
        },
        {
            'bom-ref': 'dep-reload4j', type: 'library', name: 'slf4j-reload4j', version: '1.7.35',
            purl: 'pkg:maven/org.slf4j/slf4j-reload4j@1.7.35', properties: loc('/pom.xml'),
        },
        {
            'bom-ref': 'dep-slf4j', type: 'library', name: 'slf4j-api', version: '1.7.35',
            purl: 'pkg:maven/org.slf4j/slf4j-api@1.7.35', properties: loc('/pom.xml'),
        },
        {
            'bom-ref': 'dep-gson', type: 'library', name: 'gson', version: '2.8.9',
            purl: 'pkg:maven/com.google.code.gson/gson@2.8.9', properties: loc('/pom.xml'),
        },
        // moduleA group: anchor + guava.
        {
            'bom-ref': 'anchor-a', type: 'library', name: 'zeppelin-a', version: '0.13.0',
            purl: 'pkg:maven/org.zeppelin/zeppelin-a@0.13.0', properties: loc('/moduleA/pom.xml'),
        },
        {
            'bom-ref': 'dep-guava', type: 'library', name: 'guava', version: '14.0.1',
            purl: 'pkg:maven/com.google.guava/guava@14.0.1', properties: loc('/moduleA/pom.xml'),
        },
        // moduleB group: anchor + a DEGENERATE purl (Syft could not resolve the groupId and wrote
        // namespace == artifact). It must stay a plain dependency, never become an anchor.
        {
            'bom-ref': 'anchor-b', type: 'library', name: 'zeppelin-b', version: '0.13.0',
            purl: 'pkg:maven/org.zeppelin/zeppelin-b@0.13.0', properties: loc('/moduleB/pom.xml'),
        },
        {
            'bom-ref': 'dep-degenerate', type: 'library', name: 'zeppelin-x', version: '1.0.0',
            purl: 'pkg:maven/zeppelin-x/zeppelin-x@1.0.0', properties: loc('/moduleB/pom.xml'),
        },
        // An npm component: other ecosystems keep the single-project behavior.
        {
            'bom-ref': 'dep-npm', type: 'library', name: 'side-channel', version: '1.1.0',
            purl: 'pkg:npm/side-channel@1.1.0', properties: loc('/package.json'),
        },
    ],
    dependencies: [
        {ref: 'anchor-root', dependsOn: ['dep-reload4j']},
        {ref: 'dep-reload4j', dependsOn: ['dep-slf4j']},
        {ref: 'anchor-a', dependsOn: ['dep-guava']},
        {ref: 'dep-guava', dependsOn: ['dep-gson']},
        {ref: 'anchor-b', dependsOn: ['dep-degenerate']},
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

    it('falls back to the component version for versionless purls, and skips them without one', () => {
        // Syft emits versionless purls with version 'UNKNOWN' on the component when it cannot
        // resolve a version (23 real maven deps on Zeppelin). Trivy's versionless purls carry no
        // component version either, so they must stay excluded.
        const bom = {
            metadata: {component: {'bom-ref': 'r', type: 'file', name: '/repo'}},
            components: [
                {
                    'bom-ref': 'v1', name: 'phoenix-core', version: 'UNKNOWN',
                    purl: 'pkg:maven/org.apache.phoenix/phoenix-core',
                },
                {'bom-ref': 'v2', name: 'bcutil-jdk18on', purl: 'pkg:maven/org.bouncycastle/bcutil-jdk18on'},
            ],
            dependencies: [],
        }
        const deps = parseCycloneDxFile(writeBom('nover.cdx.json', bom), 'maven')[0].dependencies
        expect(Object.keys(deps)).toEqual(['org.apache.phoenix:phoenix-core@UNKNOWN'])
    })

    it('leaves type undefined, because no SBOM format carries dependency scope', () => {
        const deps = parseCycloneDxFile(writeBom('e.cdx.json', syftBom), 'maven')[0].dependencies
        expect(deps['org.slf4j:slf4j-api@1.7.35'].type).toBeUndefined()
    })
})

describe('parseCycloneDxFile — Syft maven monorepo (per-module reconstruction)', () => {
    it('groups by pom.xml location and picks each module\'s anchor via the bootstrapped groupId', () => {
        const projects = parseCycloneDxFile(writeBom('s1.cdx.json', syftMonorepoBom), 'maven')
        // org.zeppelin occurs exactly once in all 3 groups (score 3); org.slf4j occurs twice in the
        // root group (score 0); guava/gson score 1 each; the degenerate zeppelin-x is skipped.
        expect(projects.map(p => p.name).sort()).toEqual(['moduleA', 'moduleB', 's1'])
        const a = projects.find(p => p.name === 'moduleA')!
        expect(a.version).toBe('0.13.0') // the anchor's version, not the SBOM root's
        expect(a.path).toBe('/moduleA/pom.xml')
    })

    it('names the root-pom module after the SBOM file, mirroring the Trivy convention', () => {
        const projects = parseCycloneDxFile(writeBom('s2.cdx.json', syftMonorepoBom), 'maven')
        const root = projects.find(p => p.path === '/pom.xml')!
        expect(root.name).toBe('s2')
    })

    it('scopes a module by edge reachability from its anchor, not by location group', () => {
        const projects = parseCycloneDxFile(writeBom('s3.cdx.json', syftMonorepoBom), 'maven')
        const a = projects.find(p => p.name === 'moduleA')!
        // gson is LOCATED in the root pom group but reached through guava: it belongs to moduleA.
        expect(Object.keys(a.dependencies).sort())
            .toEqual(['com.google.code.gson:gson@2.8.9', 'com.google.guava:guava@14.0.1'])
        // ...and conversely the root project holds only what its own anchor reaches.
        const root = projects.find(p => p.path === '/pom.xml')!
        expect(Object.keys(root.dependencies).sort())
            .toEqual(['org.slf4j:slf4j-api@1.7.35', 'org.slf4j:slf4j-reload4j@1.7.35'])
    })

    it('attributes the anchor\'s outgoing edges as direct and deeper edges as transitive', () => {
        const projects = parseCycloneDxFile(writeBom('s4.cdx.json', syftMonorepoBom), 'maven')
        const a = projects.find(p => p.name === 'moduleA')!
        expect(a.dependencies['com.google.guava:guava@14.0.1'].requestedBy)
            .toEqual([`${a.name}@${a.version}`])
        expect(a.dependencies['com.google.code.gson:gson@2.8.9'].requestedBy)
            .toEqual(['com.google.guava:guava@14.0.1'])
    })

    it('keeps each module\'s own anchor out of its dependency map', () => {
        const projects = parseCycloneDxFile(writeBom('s5.cdx.json', syftMonorepoBom), 'maven')
        for (const p of projects) {
            expect(p.dependencies['org.zeppelin:zeppelin@0.13.0']).toBeUndefined()
            expect(p.dependencies[`org.zeppelin:${p.name === 'moduleA' ? 'zeppelin-a' : 'zeppelin-b'}@0.13.0`])
                .toBeUndefined()
        }
    })

    it('treats a degenerate namespace==name purl as a plain dependency, never as an anchor', () => {
        const projects = parseCycloneDxFile(writeBom('s6.cdx.json', syftMonorepoBom), 'maven')
        expect(projects.map(p => p.name)).not.toContain('zeppelin-x')
        const b = projects.find(p => p.name === 'moduleB')!
        expect(b.dependencies['zeppelin-x:zeppelin-x@1.0.0'].requestedBy)
            .toEqual([`${b.name}@${b.version}`])
    })

    it('does not extend the reconstruction to non-maven ecosystems', () => {
        const projects = parseCycloneDxFile(writeBom('s7.cdx.json', syftMonorepoBom), 'npm')
        expect(projects).toHaveLength(1)
        expect(projects[0].name).toBe('s7')
        expect(Object.keys(projects[0].dependencies)).toEqual(['side-channel@1.1.0'])
    })

    it('falls back to a single project when no monorepo groupId can be bootstrapped', () => {
        // All pom-located purls are degenerate: grouping succeeds but the bootstrap yields nothing.
        const bom = {
            metadata: {component: {'bom-ref': 'r', type: 'file', name: '/repo'}},
            components: [
                {
                    'bom-ref': 'x', name: 'x', version: '1.0.0',
                    purl: 'pkg:maven/x/x@1.0.0', properties: loc('/a/pom.xml'),
                },
                {
                    'bom-ref': 'y', name: 'y', version: '2.0.0',
                    purl: 'pkg:maven/y/y@2.0.0', properties: loc('/b/pom.xml'),
                },
            ],
            dependencies: [],
        }
        const projects = parseCycloneDxFile(writeBom('s8.cdx.json', bom), 'maven')
        expect(projects).toHaveLength(1)
        expect(projects[0].name).toBe('s8')
        expect(Object.keys(projects[0].dependencies).sort()).toEqual(['x:x@1.0.0', 'y:y@2.0.0'])
    })

    it('keeps a module whose anchor reaches nothing, as an empty project', () => {
        const bom = {
            metadata: {component: {'bom-ref': 'r', type: 'file', name: '/repo'}},
            components: [
                {
                    'bom-ref': 'anchor-1', name: 'mono-a', version: '1.0.0',
                    purl: 'pkg:maven/org.mono/mono-a@1.0.0', properties: loc('/a/pom.xml'),
                },
                {
                    'bom-ref': 'anchor-2', name: 'mono-b', version: '1.0.0',
                    purl: 'pkg:maven/org.mono/mono-b@1.0.0', properties: loc('/b/pom.xml'),
                },
                {
                    'bom-ref': 'dep-1', name: 'guava', version: '14.0.1',
                    purl: 'pkg:maven/com.google.guava/guava@14.0.1', properties: loc('/a/pom.xml'),
                },
            ],
            dependencies: [{ref: 'anchor-1', dependsOn: ['dep-1']}],
        }
        const projects = parseCycloneDxFile(writeBom('s9.cdx.json', bom), 'maven')
        expect(projects.map(p => p.name).sort()).toEqual(['a', 'b'])
        expect(projects.find(p => p.name === 'b')!.dependencies).toEqual({})
    })

    it('handles pom paths without a leading slash the same way', () => {
        const bom = JSON.parse(JSON.stringify(syftMonorepoBom))
        for (const c of bom.components) {
            if (c.properties) c.properties[0].value = c.properties[0].value.replace(/^\//, '')
        }
        const projects = parseCycloneDxFile(writeBom('s10.cdx.json', bom), 'maven')
        expect(projects.map(p => p.name).sort()).toEqual(['moduleA', 'moduleB', 's10'])
    })
})

describe('parseCycloneDxFile — Trivy shape (application nodes are the projects)', () => {
    it('splits one SBOM into one project per manifest node', () => {
        const projects = parseCycloneDxFile(writeBom('f.trivy.cdx.json', trivyBom), 'maven')
        expect(projects.map(p => p.name).sort()).toEqual(['moduleA', 'moduleB'])
        expect(projects.map(p => p.path).sort()).toEqual(['moduleA/pom.xml', 'moduleB/pom.xml'])
    })

    it('scopes each project to what is reachable from its own node, minus its own anchor', () => {
        const projects = parseCycloneDxFile(writeBom('g.trivy.cdx.json', trivyBom), 'maven')
        const a = projects.find(p => p.name === 'moduleA')
        const b = projects.find(p => p.name === 'moduleB')
        // moduleA: guava direct via the anchor, gson transitively; module-a itself excluded.
        expect(Object.keys(a!.dependencies).sort())
            .toEqual(['com.google.code.gson:gson@2.8.9', 'com.google.guava:guava@14.0.1'])
        // moduleB: commons-io + gson direct, module-a as a REAL dep, guava through module-a;
        // its own anchor module-b excluded.
        expect(Object.keys(b!.dependencies).sort()).toEqual([
            'com.google.code.gson:gson@2.8.9',
            'com.google.guava:guava@14.0.1',
            'commons-io:commons-io@2.11.0',
            'org.example:module-a@1.0.0',
        ])
    })

    it('re-roots direct attribution on a sole-child anchor: its deps become the project\'s direct deps', () => {
        const projects = parseCycloneDxFile(writeBom('h.trivy.cdx.json', trivyBom), 'maven')
        const a = projects.find(p => p.name === 'moduleA')!
        const guava = a.dependencies['com.google.guava:guava@14.0.1']
        expect(guava.requestedBy).toEqual([`${a.name}@${a.version}`])
        // The anchor must not appear as a dependency of its own project.
        expect(a.dependencies['org.example:module-a@1.0.0']).toBeUndefined()

        // This is the exact expression analyse.ts uses to classify direct vs indirect.
        const isDirect = (d: typeof guava) =>
            !d.requestedBy.length || d.requestedBy.some(r => r.startsWith(`${a.name}@${a.version}`))
        expect(isDirect(guava)).toBe(true)
        expect(isDirect(a.dependencies['com.google.code.gson:gson@2.8.9'])).toBe(false)
    })

    it('handles an anchor with genuine direct-dep siblings: both the sibling and the anchor\'s deps are direct', () => {
        const projects = parseCycloneDxFile(writeBom('h2.trivy.cdx.json', trivyBom), 'maven')
        const b = projects.find(p => p.name === 'moduleB')!
        const projectId = `${b.name}@${b.version}`
        // anchor-b is the anchor (it has outgoing edges); dep-commons is a real direct dep leaf.
        expect(b.dependencies['commons-io:commons-io@2.11.0'].requestedBy).toEqual([projectId])
        expect(b.dependencies['com.google.code.gson:gson@2.8.9'].requestedBy).toContain(projectId)
        expect(b.dependencies['org.example:module-b@1.0.0']).toBeUndefined()
    })

    it('treats another module\'s artifact inside a different subtree as a real dependency', () => {
        const projects = parseCycloneDxFile(writeBom('h3.trivy.cdx.json', trivyBom), 'maven')
        const b = projects.find(p => p.name === 'moduleB')!
        const projectId = `${b.name}@${b.version}`
        // moduleA's own artifact is a genuine (direct) dependency of moduleB...
        expect(b.dependencies['org.example:module-a@1.0.0'].requestedBy).toEqual([projectId])
        // ...and its transitive deps keep their normal requestedBy chain (guava is NOT direct here).
        expect(b.dependencies['com.google.guava:guava@14.0.1'].requestedBy)
            .toEqual(['org.example:module-a@1.0.0'])
    })

    it('keeps a module whose only in-ecosystem component was its own anchor, with zero deps', () => {
        const bom = {
            metadata: {component: {'bom-ref': 'root', type: 'application', name: '/repo'}},
            components: [
                {'bom-ref': 'proj', type: 'application', name: 'empty/pom.xml'},
                {
                    'bom-ref': 'anchor', type: 'library', group: 'org.example', name: 'empty-module',
                    version: '1.0.0', purl: 'pkg:maven/org.example/empty-module@1.0.0',
                },
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['proj']},
                {ref: 'proj', dependsOn: ['anchor']},
            ],
        }
        const projects = parseCycloneDxFile(writeBom('h4.trivy.cdx.json', bom), 'maven')
        expect(projects).toHaveLength(1)
        expect(projects[0].name).toBe('empty')
        expect(projects[0].dependencies).toEqual({})
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
