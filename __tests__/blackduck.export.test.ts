import fs from 'fs'
import os from 'os'
import path from 'path'
import {BLACKDUCK_FILES, writeBlackDuckExport, writeSecurityCsv} from '../src/blackduck/export'
import {licenseColumns} from '../src/blackduck/licenses'
import {AnalysedEcosystem, buildModel} from '../src/blackduck/model'
import {componentLink, originForPurlType, originId} from '../src/blackduck/origins'
import {packageManagerTag, sbomPaths} from '../src/blackduck/paths'
import {upgradeGuidance} from '../src/blackduck/upgrade'
import {DepinderDependency, DepinderProject} from '../src/extension-points/extract'
import {Vulnerability} from '../src/extension-points/vulnerability-checker'

/**
 * The Black Duck-shaped export.
 *
 * The headers themselves are checked against the real export in
 * `BD-trivy-syft-comparison/inputs/blackduck/ruby-mastodon/export/` by the reproduction commands
 * in the README (`diff <(head -1 ours) <(head -1 theirs)`); what is checked here is that the rows
 * underneath them are derived from depinder's model the way the column mapping says they are.
 */

const advisory: Vulnerability = {
    severity: 'HIGH',
    score: 9.8,
    description: 'qs prototype pollution',
    permalink: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
    timestamp: Date.parse('2022-11-27T00:30:50Z'),
    identifiers: [
        {value: 'GHSA-hrpp-h998-j3pp', type: 'GHSA'},
        {value: 'CVE-2022-24999', type: 'CVE'},
    ],
    firstPatchedVersion: '6.10.3',
    source: 'github',
    cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    cvssVersion: '3.1',
    cweIds: ['CWE-1321'],
}

function dependency(overrides: Partial<DepinderDependency> = {}): DepinderDependency {
    return {
        id: 'qs@6.10.2',
        name: 'qs',
        version: '6.10.2',
        semver: null,
        requestedBy: ['js-npm-nest@1.0.0'],
        vulnerabilities: [advisory],
        libraryInfo: {
            name: 'qs',
            licenses: ['BSD-3-Clause'],
            homepageUrl: 'https://github.com/ljharb/qs',
            versions: [
                {version: '6.10.2', timestamp: Date.parse('2021-10-06T00:00:00Z'), latest: false},
                {version: '6.10.3', timestamp: Date.parse('2022-01-01T00:00:00Z'), latest: false},
                {version: '6.11.0', timestamp: Date.parse('2022-06-01T00:00:00Z'), latest: true},
            ],
        },
        ...overrides,
    } as DepinderDependency
}

function ecosystem(...dependencies: DepinderDependency[]): AnalysedEcosystem {
    const project: DepinderProject = {
        name: 'js-npm-nest',
        version: '1.0.0',
        path: 'package.json',
        dependencies: Object.fromEntries(dependencies.map(it => [it.id, it])),
    }
    return {purlType: 'npm', projects: [project]}
}

describe('origins', () => {
    it('uses Black Duck\'s registry names, not the purl types', () => {
        expect(originForPurlType('npm').name).toBe('npmjs')
        expect(originForPurlType('gem').name).toBe('rubygems')
        expect(originForPurlType('composer').name).toBe('packagist')
        expect(originForPurlType('cargo').name).toBe('crates')
        expect(originForPurlType('conan').name).toBe('unknown')
    })

    // Read off the real export: the slash origins and the colon origins are different families,
    // and using the wrong one makes every row look like a row Black Duck does not have.
    it('separates the version with the character that origin uses', () => {
        expect(originId(originForPurlType('npm'), '@babel/core', '7.0.0')).toBe('@babel/core/7.0.0')
        expect(originId(originForPurlType('gem'), 'actionmailer', '8.1.3.1')).toBe('actionmailer/8.1.3.1')
        expect(originId(originForPurlType('maven'), 'commons-logging:commons-logging', '1.2'))
            .toBe('commons-logging:commons-logging:1.2')
        expect(originId(originForPurlType('composer'), 'monolog/monolog', '3.9.0')).toBe('monolog/monolog:3.9.0')
    })

    it('prefers the registrar\'s homepage and falls back to the registry page', () => {
        expect(componentLink(originForPurlType('npm'), 'qs', '6.10.2', 'https://example.test'))
            .toBe('https://example.test')
        expect(componentLink(originForPurlType('gem'), 'rails', '7.1.0'))
            .toBe('https://rubygems.org/gems/rails/versions/7.1.0')
        expect(componentLink(originForPurlType('maven'), 'g:a', '1.0')).toBe('')
    })
})

describe('licence columns', () => {
    it('maps an SPDX id to Black Duck\'s display name and family', () => {
        expect(licenseColumns(['MIT'])).toEqual({names: 'MIT License', families: 'PERMISSIVE'})
        expect(licenseColumns(['Apache-2.0'])).toEqual({names: 'Apache License 2.0', families: 'PERMISSIVE'})
        expect(licenseColumns(['MPL-2.0'])).toEqual({
            names: 'Mozilla Public License 2.0', families: 'WEAK_RECIPROCAL',
        })
    })

    it('renders an SPDX expression the way Black Duck does', () => {
        expect(licenseColumns(['MIT OR Apache-2.0'])).toEqual({
            names: '(MIT License OR Apache License 2.0)',
            families: 'PERMISSIVE',
        })
        expect(licenseColumns(['GPL-3.0 AND MIT']).families).toBe('RECIPROCAL,PERMISSIVE')
    })

    it('keeps an unmapped id visible rather than claiming a family for it', () => {
        expect(licenseColumns(['Weird-1.0'])).toEqual({names: 'Weird-1.0', families: 'UNKNOWN'})
        expect(licenseColumns([])).toEqual({names: 'Unknown License', families: 'UNKNOWN'})
    })
})

describe('the export model', () => {
    it('reports a component reached both ways as Direct,Transitive', () => {
        const both = dependency({requestedBy: ['js-npm-nest@1.0.0', 'express@4.18.0']})
        expect(buildModel('p', [ecosystem(both)], []).components[0].matchType).toBe('Direct,Transitive')
        expect(buildModel('p', [ecosystem(dependency())], []).components[0].matchType).toBe('Direct')
        expect(buildModel('p', [ecosystem(dependency({requestedBy: ['express@4.18.0']}))], [])
            .components[0].matchType).toBe('Transitive')
    })

    it('counts newer versions with the ecosystem\'s own ordering', () => {
        const [component] = buildModel('p', [ecosystem(dependency())], []).components
        expect(component.newerVersions).toBe('2')
        expect(component.releaseDate).toBe('2021-10-06')
    })

    // A component enriched by two projects must not report the same advisory twice; two findings
    // are the same finding when they share any identifier, as merge.ts already decides.
    it('reports one advisory once however many projects carry the component', () => {
        const first = ecosystem(dependency())
        const second = ecosystem(dependency({vulnerabilities: [{...advisory, identifiers: [{value: 'CVE-2022-24999', type: 'CVE'}]}]}))
        expect(buildModel('p', [first, second], []).findings).toHaveLength(1)
    })
})

describe('upgrade guidance', () => {
    it('recommends the lowest fix at or above the current version, and the highest overall', () => {
        const [guidance] = upgradeGuidance(buildModel('p', [ecosystem(dependency())], []).components)
        expect(guidance.shortTerm).toBe('6.10.3')
        expect(guidance.longTerm).toBe('6.11.0')
    })

    it('recommends nothing when a finding names no fix', () => {
        const unfixed = dependency({vulnerabilities: [{...advisory, firstPatchedVersion: undefined}]})
        const [guidance] = upgradeGuidance(buildModel('p', [ecosystem(unfixed)], []).components)
        expect(guidance.shortTerm).toBeUndefined()
        expect(guidance.longTerm).toBeUndefined()
    })

    it('skips components with no findings at all', () => {
        const clean = dependency({vulnerabilities: []})
        expect(upgradeGuidance(buildModel('p', [ecosystem(clean)], []).components)).toHaveLength(0)
    })
})

describe('dependency paths', () => {
    const write = (bom: unknown): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-paths-'))
        const file = path.join(dir, 'demo.cdx.json')
        fs.writeFileSync(file, JSON.stringify(bom))
        return file
    }

    it('walks dependsOn from a Trivy application node, tagged with its package manager', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'yarn.lock'},
                {'bom-ref': 'a', purl: 'pkg:npm/express@4.18.0'},
                {'bom-ref': 'b', purl: 'pkg:npm/qs@6.10.2'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['a']},
                {ref: 'a', dependsOn: ['b']},
            ],
        })
        expect(sbomPaths(file, 'demo', new Set(['npm']))).toEqual([
            {name: 'express', version: '4.18.0', purlType: 'npm', projectPath: 'demo',
                matchType: 'Direct', path: 'demo/-yarn/express/4.18.0'},
            {name: 'qs', version: '6.10.2', purlType: 'npm', projectPath: 'demo',
                matchType: 'Transitive', path: 'demo/-yarn/express/4.18.0/qs/6.10.2'},
        ])
    })

    // Black Duck writes one path per component: the shortest chain, not every chain.
    it('reports a component pulled in by two parents once, by its shortest chain', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'package-lock.json'},
                {'bom-ref': 'a', purl: 'pkg:npm/express@4.18.0'},
                {'bom-ref': 'b', purl: 'pkg:npm/body-parser@1.20.0'},
                {'bom-ref': 'c', purl: 'pkg:npm/qs@6.10.2'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['a', 'b']},
                {ref: 'a', dependsOn: ['b']},
                {ref: 'b', dependsOn: ['c']},
            ],
        })
        const qs = sbomPaths(file, 'demo', new Set(['npm'])).filter(it => it.name === 'qs')
        expect(qs.map(it => it.path)).toEqual(['demo/-npm/body-parser/1.20.0/qs/6.10.2'])
    })

    it('starts a self-anchored manifest below its own artifact, which is never a segment', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'go.mod'},
                {'bom-ref': 'main', purl: 'pkg:golang/github.com/caddyserver/caddy/v2'},
                {'bom-ref': 'a', purl: 'pkg:golang/github.com/caddyserver/certmagic@v0.25.4'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['main']},
                {ref: 'main', dependsOn: ['a']},
            ],
        })
        expect(sbomPaths(file, 'go-caddy', new Set(['golang']))).toEqual([
            {name: 'github.com/caddyserver/certmagic', version: 'v0.25.4', purlType: 'golang', projectPath: 'go-caddy',
                matchType: 'Direct', path: 'go-caddy/-go_mod/github.com/caddyserver/certmagic/v0.25.4'},
        ])
    })

    it('names the module in the project path for a manifest below the top level', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'fuzz/Cargo.lock'},
                {'bom-ref': 'crate', purl: 'pkg:cargo/fuzz@0.0.1'},
                {'bom-ref': 'a', purl: 'pkg:cargo/libfuzzer-sys@0.4.7'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['crate']},
                {ref: 'crate', dependsOn: ['a']},
            ],
        })
        expect(sbomPaths(file, 'rust-ripgrep', new Set(['cargo']))[0]).toMatchObject({
            projectPath: 'rust-ripgrep/fuzz', path: 'rust-ripgrep/fuzz/-cargo/libfuzzer-sys/0.4.7',
        })
    })

    // Syft emits no project node; a yarn workspace node is the one place it carries a chain's
    // start. What no workspace reaches is reported at the root, tagged by its own manifest.
    it('walks a Syft SBOM from its yarn workspaces and reports the rest at the root level', () => {
        const at = (manifest: string) => [{name: 'syft:location:0:path', value: manifest}]
        const file = write({
            metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [
                {'bom-ref': 'ws', name: '@mastodon/mastodon', version: '0.0.0-use.local',
                    purl: 'pkg:npm/%40mastodon/mastodon@0.0.0-use.local', properties: at('/yarn.lock')},
                {'bom-ref': 'a', purl: 'pkg:npm/vite@7.3.1', properties: at('/yarn.lock')},
                {'bom-ref': 'b', purl: 'pkg:npm/rollup@4.60.1', properties: at('/yarn.lock')},
                {'bom-ref': 'c', purl: 'pkg:npm/cacheable@2.3.4', properties: at('/yarn.lock')},
                {'bom-ref': 'g', purl: 'pkg:gem/nokogiri@1.13.8', properties: at('/Gemfile.lock')},
            ],
            dependencies: [{ref: 'ws', dependsOn: ['a']}, {ref: 'a', dependsOn: ['b']}],
        })
        expect(sbomPaths(file, 'demo', new Set(['npm', 'gem'])).map(it => [it.matchType, it.path])).toEqual([
            ['Direct', 'demo/-yarn/vite/7.3.1'],
            ['Transitive', 'demo/-yarn/vite/7.3.1/rollup/4.60.1'],
            ['Direct', 'demo/-yarn/cacheable/2.3.4'],
            ['Direct', 'demo/-rubygems/nokogiri/1.13.8'],
        ])
    })

    it('falls back to the origin name when neither tool recorded a manifest', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [{'bom-ref': 'a', purl: 'pkg:gem/nokogiri@1.13.8'}],
        })
        expect(sbomPaths(file, 'demo', new Set(['gem']))[0].path).toBe('demo/-rubygems/nokogiri/1.13.8')
    })

    it('tags a path by the manifest\'s package manager, as Black Duck does', () => {
        expect(packageManagerTag('yarn.lock')).toBe('yarn')
        expect(packageManagerTag('streaming/package-lock.json')).toBe('npm')
        expect(packageManagerTag('pnpm-lock.yaml')).toBe('pnpm')
        expect(packageManagerTag('/Gemfile.lock')).toBe('rubygems')
        expect(packageManagerTag('neo4j/pom.xml')).toBe('maven')
        expect(packageManagerTag('gradle.lockfile')).toBe('gradle')
        expect(packageManagerTag('composer.lock')).toBe('packagist')
        expect(packageManagerTag('src/Web/Web.csproj')).toBe('nuget')
        expect(packageManagerTag('uv.lock')).toBe('uv')
        expect(packageManagerTag('unknown.lock')).toBeUndefined()
    })
})

describe('the written files', () => {
    const readCsv = (folder: string, file: string): string[] =>
        fs.readFileSync(path.join(folder, file), 'utf8').split('\n')

    let folder: string
    beforeEach(() => {
        folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-bd-'))
    })

    it('writes all five files', () => {
        const model = buildModel('demo', [ecosystem(dependency())], [])
        const written = writeBlackDuckExport(model, folder)
        expect(written.map(it => it.file)).toEqual([...BLACKDUCK_FILES])
        for (const file of BLACKDUCK_FILES) expect(fs.existsSync(path.join(folder, file))).toBe(true)
    })

    it('spells the first _dependencies.csv column the way Black Duck does', () => {
        writeBlackDuckExport(buildModel('demo', [ecosystem(dependency())], []), folder)
        expect(readCsv(folder, '_dependencies.csv')[0].startsWith('1Component name,')).toBe(true)
    })

    it('fills a dependency row from the model', () => {
        writeBlackDuckExport(buildModel('demo', [ecosystem(dependency())], []), folder)
        const [, row] = readCsv(folder, '_dependencies.csv')
        expect(row).toBe([
            'qs', '6.10.2', 'qs/6.10.2', 'BSD 3-clause ""New"" or ""Revised"" License'.replace(/""/g, '"'),
            'PERMISSIVE', 'Direct', 'DYNAMICALLY_LINKED', '', 'npmjs', '',
            '1', '1', '0', '1', '0', '0',
            '2021-10-06', '2', '', '', '', 'false', 'https://github.com/ljharb/qs', '',
        ].map(it => (/[",]/.test(it) ? `"${it.replaceAll('"', '""')}"` : it)).join(','))
    })

    it('writes the vulnerability id as Black Duck pairs a GHSA with its CVE', () => {
        writeBlackDuckExport(buildModel('demo', [ecosystem(dependency())], []), folder)
        const [, row] = readCsv(folder, '_vulnerability_details.csv')
        expect(row).toContain('GHSA-hrpp-h998-j3pp (CVE-2022-24999)')
        expect(row).toContain('[CWE-1321]')
        expect(row).toContain('CVSS 3.x')
        expect(row).toContain('Direct Dependency')
        expect(row).toContain('GHSA')
    })

    it('gives security.csv the same rows as _vulnerability_details.csv', () => {
        const model = buildModel('demo', [ecosystem(dependency())], [])
        writeBlackDuckExport(model, folder)
        expect(readCsv(folder, 'security.csv')).toHaveLength(readCsv(folder, '_vulnerability_details.csv').length)
    })

    it('writes security.csv on its own for the analyse command', () => {
        const written = writeSecurityCsv(buildModel('demo', [ecosystem(dependency())], []), folder)
        expect(written).toEqual({file: 'security.csv', rows: 1})
        expect(fs.existsSync(path.join(folder, '_dependencies.csv'))).toBe(false)
    })

    it('drops a path whose component no plugin enriched', () => {
        const model = buildModel('demo', [ecosystem(dependency())], [
            {name: 'unseen', version: '1.0.0', purlType: 'npm', path: 'demo/-npmjs/unseen/1.0.0',
                projectPath: 'demo', matchType: 'Direct'},
        ])
        writeBlackDuckExport(model, folder)
        expect(readCsv(folder, '_dependencies_sources.csv')).toHaveLength(1)
    })
})
