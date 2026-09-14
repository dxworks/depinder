import fs from 'fs'
import os from 'os'
import path from 'path'
import {BLACKDUCK_FILES, writeBlackDuckExport, writeSecurityCsv} from '../src/blackduck/export'
import {licenseColumns} from '../src/blackduck/licenses'
import {AnalysedEcosystem, buildModel} from '../src/blackduck/model'
import {canonicalProjectUrl, componentLink, goPseudoVersionCommit, originFor, originId} from '../src/blackduck/origins'
import {packageManagerTag, sbomPaths, sbomTree} from '../src/blackduck/paths'
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
    const origin = (purlType: string, name = 'x') => originFor(purlType, name)

    it('uses Black Duck\'s registry names, not the purl types', () => {
        expect(origin('npm').name).toBe('npmjs')
        expect(origin('gem').name).toBe('rubygems')
        expect(origin('composer').name).toBe('packagist')
        expect(origin('cargo').name).toBe('crates')
        expect(origin('conan').name).toBe('unknown')
    })

    // Read off the real export: name/version for the registries, name:version for maven and
    // packagist (the slash in `monolog/monolog` is part of the name).
    it('separates the version with the character that origin uses', () => {
        expect(originId(origin('npm'), '@babel/core', '7.0.0')).toBe('@babel/core/7.0.0')
        expect(originId(origin('gem'), 'actionmailer', '8.1.3.1')).toBe('actionmailer/8.1.3.1')
        expect(originId(origin('maven'), 'commons-logging:commons-logging', '1.2'))
            .toBe('commons-logging:commons-logging:1.2')
        expect(originId(origin('composer'), 'monolog/monolog', '3.9.0')).toBe('monolog/monolog:3.9.0')
        expect(originId(origin('cargo'), 'aho-corasick', '1.1.2')).toBe('aho-corasick/1.1.2')
    })

    // Go modules are filed by host: github.com under `github` as owner/repo (major suffix and
    // subpath dropped), golang.org/x under `long_tail` as the go.googlesource.com mirror, and any
    // other host under `unknown`, since the repo behind a vanity import is Knowledge Base data.
    it('files a Go module under the origin Black Duck uses for its host', () => {
        const semver = 'github.com/Masterminds/semver/v3'
        expect(origin('golang', semver).name).toBe('github')
        expect(originId(origin('golang', semver), semver, 'v3.4.0')).toBe('Masterminds/semver:v3.4.0')
        const sys = 'golang.org/x/sys'
        expect(origin('golang', sys).name).toBe('long_tail')
        expect(originId(origin('golang', sys), sys, 'v0.47.0')).toBe('go.googlesource.com/sys#v0.47.0')
        const fallback = 'golang.org/x/crypto/x509roots/fallback'
        expect(originId(origin('golang', fallback), fallback, 'v0.0.0-20260709184058-243e02a382f8'))
            .toBe('go.googlesource.com/crypto#243e02a382f8')
        const zap = 'go.uber.org/zap'
        expect(origin('golang', zap).name).toBe('unknown')
        expect(originId(origin('golang', zap), zap, 'v1.28.0')).toBe('go.uber.org/zap:v1.28.0')
    })

    it('writes a pseudo-version as the commit it names, in all three shapes', () => {
        expect(goPseudoVersionCommit('v0.0.0-20210328193216-ff5ff6dc229b')).toBe('ff5ff6dc229b')
        expect(goPseudoVersionCommit('v1.1.8-0.20240110162603-74a5dd331745')).toBe('74a5dd331745')
        expect(goPseudoVersionCommit('v2.0.0-pre.0.20230729083705-37449abec8cc')).toBe('37449abec8cc')
        expect(goPseudoVersionCommit('v1.5.4')).toBe('v1.5.4')
        expect(goPseudoVersionCommit('v1.2.3-beta.1')).toBe('v1.2.3-beta.1')
    })

    it('writes the project the registrar found, and nothing when there is none', () => {
        expect(componentLink(origin('npm'), 'qs', 'https://example.test')).toBe('https://example.test')
        // No homepage is an empty cell, not the package's page on the registry: Black Duck leaves
        // the column blank for the 333 components its Knowledge Base has no project for.
        expect(componentLink(origin('gem'), 'rails')).toBe('')
        expect(componentLink(origin('npm'), 'qs', '  ')).toBe('')
        expect(componentLink(origin('maven'), 'g:a')).toBe('')
    })

    it('falls back to the repository for a Go module GitHub itself serves', () => {
        // The module path is the repository, so this is the project, not a registry page. The
        // major-version suffix is not part of the repository name.
        expect(componentLink(origin('golang', 'github.com/beorn7/perks'), 'github.com/beorn7/perks'))
            .toBe('https://github.com/beorn7/perks')
        expect(componentLink(origin('golang', 'github.com/dgraph-io/badger/v2'), 'github.com/dgraph-io/badger/v2'))
            .toBe('https://github.com/dgraph-io/badger')
        // What the proxy reported still wins over the fallback.
        expect(componentLink(origin('golang', 'github.com/dgraph-io/badger/v2'), 'github.com/dgraph-io/badger/v2', 'https://open.dgraph.io/post/badger/'))
            .toBe('https://open.dgraph.io/post/badger/')
        // A module no origin claims has no repository to guess at.
        expect(componentLink(origin('golang', 'go.uber.org/zap'), 'go.uber.org/zap')).toBe('')
    })

    it('unwraps a clone URL into the page Black Duck holds', () => {
        expect(canonicalProjectUrl('git+https://github.com/php-http/httplug.git'))
            .toBe('https://github.com/php-http/httplug')
        expect(canonicalProjectUrl('git://github.com/dominictarr/through.git'))
            .toBe('https://github.com/dominictarr/through')
        expect(canonicalProjectUrl('git@github.com:goinstant/buffer-equal-constant-time.git'))
            .toBe('https://github.com/goinstant/buffer-equal-constant-time')
        expect(canonicalProjectUrl('ssh://git@github.com/owner/repo.git'))
            .toBe('https://github.com/owner/repo')
        // A fragment that is part of the page survives; the one a clone URL uses for a ref does not.
        expect(canonicalProjectUrl('https://github.com/sindresorhus/quick-lru#readme'))
            .toBe('https://github.com/sindresorhus/quick-lru#readme')
        expect(canonicalProjectUrl('git+https://github.com/gregberge/svgr.git#main'))
            .toBe('https://github.com/gregberge/svgr#main')
        // Anything that would not open in a browser is dropped rather than written.
        expect(canonicalProjectUrl('mailto:maintainer@example.test')).toBe('')
        expect(canonicalProjectUrl('../relative/path')).toBe('')
        expect(canonicalProjectUrl(undefined)).toBe('')
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
        // Operands come back in Black Duck's order, and so do their families.
        expect(licenseColumns(['GPL-3.0 AND MIT']))
            .toEqual({names: '(MIT License AND GNU General Public License v3.0)', families: 'PERMISSIVE,RECIPROCAL'})
    })

    it('keeps an unmapped id visible rather than claiming a family for it', () => {
        expect(licenseColumns(['Weird-1.0'])).toEqual({names: 'Weird-1.0', families: 'UNKNOWN'})
        expect(licenseColumns([])).toEqual({names: 'Unknown License', families: 'UNKNOWN'})
    })
})

describe('the export model', () => {
    it('reports a component reached both ways as Direct,Transitive', () => {
        const both = dependency({requestedBy: ['js-npm-nest@1.0.0', 'express@4.18.0']})
        expect(buildModel('p', [ecosystem(both)], []).components[0].matchType).toBe('Direct Dependency,Transitive Dependency')
        expect(buildModel('p', [ecosystem(dependency())], []).components[0].matchType).toBe('Direct Dependency')
        expect(buildModel('p', [ecosystem(dependency({requestedBy: ['express@4.18.0']}))], [])
            .components[0].matchType).toBe('Transitive Dependency')
    })

    it('takes the licence of the resolved version, not of the package', () => {
        // @cdxgen/cdxgen-plugins-bin, verbatim: Apache-2.0 through 2.x, MIT from 3.x. The
        // library-level field reports only the current licence, so preferring it would relicense
        // every older version in the report -- Black Duck reports 2.1.1 as Apache-2.0.
        const relicensed = dependency({
            version: '2.1.1',
            libraryInfo: {
                name: '@cdxgen/cdxgen-plugins-bin',
                licenses: ['MIT'],
                versions: [
                    {version: '2.1.1', timestamp: Date.parse('2026-05-07T00:00:00Z'), licenses: 'Apache-2.0', latest: false},
                    {version: '3.1.0', timestamp: Date.parse('2026-08-30T00:00:00Z'), licenses: 'MIT', latest: true},
                ],
            },
        } as never)
        expect(buildModel('p', [ecosystem(relicensed)], []).components[0].licenses).toEqual(['Apache-2.0'])
    })

    it('keeps the library licence when the version carries an id nothing can map', () => {
        // crates.io writes `MIT/Apache-2.0` on the version and the clean SPDX expression on the
        // library. Black Duck reports `(MIT License OR Apache License 2.0)`, so the readable one wins.
        const shorthand = dependency({
            version: '1.4.1',
            libraryInfo: {
                name: 'derive_arbitrary',
                licenses: ['MIT OR Apache-2.0'],
                versions: [{version: '1.4.1', timestamp: Date.parse('2024-10-01T00:00:00Z'), licenses: 'MIT/Apache-2.0', latest: true}],
            },
        } as never)
        // Either list renders to the same cell now that the shorthand is readable, so the more
        // specific one -- the version's -- is the one kept.
        const kept = buildModel('p', [ecosystem(shorthand)], []).components[0].licenses
        expect(licenseColumns(kept).names).toBe('(MIT License OR Apache License 2.0)')
    })

    it('still takes an unmappable version licence when the library has none either', () => {
        const both = dependency({
            version: '1.0.0',
            libraryInfo: {
                name: 'odd',
                licenses: ['Also-Not-SPDX'],
                versions: [{version: '1.0.0', timestamp: Date.parse('2024-10-01T00:00:00Z'), licenses: 'BSD-like', latest: true}],
            },
        } as never)
        expect(buildModel('p', [ecosystem(both)], []).components[0].licenses).toEqual(['BSD-like'])
    })

    it('falls back to the library licence when the version carries none', () => {
        expect(buildModel('p', [ecosystem(dependency())], []).components[0].licenses).toEqual(['BSD-3-Clause'])
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
                matchType: 'Direct Dependency', path: 'demo/-yarn/express/4.18.0'},
            {name: 'qs', version: '6.10.2', purlType: 'npm', projectPath: 'demo',
                matchType: 'Transitive Dependency', path: 'demo/-yarn/express/4.18.0/qs/6.10.2'},
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

    // Black Duck breaks a tie between equally short chains towards the greater parent.
    it('breaks a tie between equally short chains towards the greater parent', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'Gemfile.lock'},
                {'bom-ref': 'a', name: 'active_model_serializers', version: '0.10.16', purl: 'pkg:gem/active_model_serializers@0.10.16'},
                {'bom-ref': 'b', name: 'rspec-rails', version: '8.0.4', purl: 'pkg:gem/rspec-rails@8.0.4'},
                {'bom-ref': 'c', name: 'actionpack', version: '8.1.3.1', purl: 'pkg:gem/actionpack@8.1.3.1'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['a', 'b']},
                {ref: 'a', dependsOn: ['c']},
                {ref: 'b', dependsOn: ['c']},
            ],
        })
        const actionpack = sbomPaths(file, 'demo', new Set(['gem'])).find(it => it.name === 'actionpack')
        expect(actionpack?.path).toBe('demo/-rubygems/rspec-rails/8.0.4/actionpack/8.1.3.1')
    })

    // Black Duck joins a segment's name and version the way the origin id does: a colon for
    // maven and packagist, a slash elsewhere.
    it('joins a segment with the separator its origin id uses', () => {
        const file = write({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'composer.lock'},
                {'bom-ref': 'a', purl: 'pkg:composer/laravel/fortify@v1.28.0'},
                {'bom-ref': 'b', purl: 'pkg:composer/bacon/bacon-qr-code@v3.0.1'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['a']},
                {ref: 'a', dependsOn: ['b']},
            ],
        })
        expect(sbomPaths(file, 'php-monica', new Set(['composer'])).map(it => it.path)).toEqual([
            'php-monica/-packagist/laravel/fortify:v1.28.0',
            'php-monica/-packagist/laravel/fortify:v1.28.0/bacon/bacon-qr-code:v3.0.1',
        ])
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
                matchType: 'Direct Dependency', path: 'go-caddy/-go_mod/github.com/caddyserver/certmagic:v0.25.4'},
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
            ['Direct Dependency', 'demo/-yarn/vite/7.3.1'],
            ['Transitive Dependency', 'demo/-yarn/vite/7.3.1/rollup/4.60.1'],
            ['Direct Dependency', 'demo/-yarn/cacheable/2.3.4'],
            ['Direct Dependency', 'demo/-rubygems/nokogiri/1.13.8'],
        ])
    })

    // Syft's `metadata.component` is a `file` and never appears in `dependencies[]`, so outside
    // yarn there is no anchor to walk from. The chains are still there; the entry point is every
    // ref nothing points at. Before this was handled, every npm/pnpm/nuget/pypi/cargo component
    // came out one-hop and `Direct`.
    it('walks a Syft SBOM with no workspace anchor from the refs nothing points at', () => {
        const at = (manifest: string) => [{name: 'syft:location:0:path', value: manifest}]
        const file = write({
            metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [
                {'bom-ref': 'a', purl: 'pkg:npm/supertest@7.2.2', properties: at('/package-lock.json')},
                {'bom-ref': 'b', purl: 'pkg:npm/superagent@10.2.3', properties: at('/package-lock.json')},
                {'bom-ref': 'c', purl: 'pkg:npm/formidable@3.5.4', properties: at('/package-lock.json')},
                {'bom-ref': 'd', purl: 'pkg:npm/dezalgo@1.0.4', properties: at('/package-lock.json')},
            ],
            dependencies: [
                {ref: 'a', dependsOn: ['b']},
                {ref: 'b', dependsOn: ['c']},
                {ref: 'c', dependsOn: ['d']},
            ],
        })
        expect(sbomPaths(file, 'js-npm-nest', new Set(['npm'])).map(it => [it.matchType, it.path])).toEqual([
            ['Direct Dependency', 'js-npm-nest/-npm/supertest/7.2.2'],
            ['Transitive Dependency', 'js-npm-nest/-npm/supertest/7.2.2/superagent/10.2.3'],
            ['Transitive Dependency', 'js-npm-nest/-npm/supertest/7.2.2/superagent/10.2.3/formidable/3.5.4'],
            ['Transitive Dependency', 'js-npm-nest/-npm/supertest/7.2.2/superagent/10.2.3/formidable/3.5.4/dezalgo/1.0.4'],
        ])
    })

    it('writes the graph as edges, with each component\'s depth and no chain to lose it in', () => {
        const at = (manifest: string) => [{name: 'syft:location:0:path', value: manifest}]
        const sbom = write({
            metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [
                {'bom-ref': 'a', purl: 'pkg:npm/supertest@7.2.2', properties: at('/package-lock.json')},
                {'bom-ref': 'b', purl: 'pkg:npm/superagent@10.2.3', properties: at('/package-lock.json')},
                {'bom-ref': 'c', purl: 'pkg:npm/formidable@3.5.4', properties: at('/package-lock.json')},
            ],
            // formidable has two parents: the chain keeps one of them, the edge table both.
            dependencies: [{ref: 'a', dependsOn: ['b', 'c']}, {ref: 'b', dependsOn: ['c']}],
        })
        const {paths, edges} = sbomTree(sbom, 'js-npm-nest', new Set(['npm']))
        expect(paths.filter(it => it.name === 'formidable')).toHaveLength(1)
        expect(edges.map(it => [it.parent, it.child, it.depth])).toEqual([
            ['(root)', 'supertest/7.2.2', 1],
            ['supertest/7.2.2', 'superagent/10.2.3', 2],
            ['supertest/7.2.2', 'formidable/3.5.4', 2],
            ['superagent/10.2.3', 'formidable/3.5.4', 2],
        ])
        expect(edges.every(it => it.repo === 'js-npm-nest' && it.tree === 'js-npm-nest/-npm')).toBe(true)
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

    it('writes all six files', () => {
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
            // Operational Risk HIGH: released 2021-10-06 with 2 newer versions, so over four
            // years stale. License Risk OK: BSD-3-Clause is PERMISSIVE.
            'PERMISSIVE', 'Direct Dependency', 'DYNAMICALLY_LINKED', 'HIGH', 'npmjs', 'OK',
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
                projectPath: 'demo', matchType: 'Direct Dependency'},
        ])
        writeBlackDuckExport(model, folder)
        expect(readCsv(folder, '_dependencies_sources.csv')).toHaveLength(1)
    })
})
