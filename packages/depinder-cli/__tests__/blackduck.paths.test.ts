import fs from 'fs'
import os from 'os'
import path from 'path'
import {sbomTree} from '../src/blackduck/paths'

let folder: string
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-paths-')) })
afterEach(() => fs.rmSync(folder, {recursive: true, force: true}))

function writeSbom(bom: {components: unknown[], dependencies?: unknown[], metadata?: unknown}): string {
    const file = path.join(folder, 'demo.cdx.json')
    fs.writeFileSync(file, JSON.stringify({metadata: {component: {'bom-ref': 'root'}}, ...bom}))
    return file
}

const location = (manifest: string) => [{name: 'syft:location:0:path', value: manifest}]

describe('dependency paths and graph edges', () => {
    it.each([
        ['package-lock.json', 'npm', 'pkg:npm/lib@1.0.0', 'lib/1.0.0', 'npm'],
        ['yarn.lock', 'npm', 'pkg:npm/lib@1.0.0', 'lib/1.0.0', 'yarn'],
        ['pnpm-lock.yaml', 'npm', 'pkg:npm/lib@1.0.0', 'lib/1.0.0', 'pnpm'],
        ['uv.lock', 'pypi', 'pkg:pypi/lib@1.0.0', 'lib/1.0.0', 'uv'],
        ['Client.csproj', 'nuget', 'pkg:nuget/lib@1.0.0', 'lib/1.0.0', 'nuget'],
        ['pom.xml', 'maven', 'pkg:maven/com.vendor/lib@1.0.0', 'com.vendor:lib:1.0.0', 'maven'],
        ['build.gradle', 'maven', 'pkg:maven/com.vendor/lib@1.0.0', 'com.vendor:lib:1.0.0', 'gradle'],
        ['gradle.lockfile', 'maven', 'pkg:maven/com.vendor/lib@1.0.0', 'com.vendor:lib:1.0.0', 'gradle'],
        ['go.mod', 'golang', 'pkg:golang/example.com/lib@v1.0.0', 'example.com/lib:v1.0.0', 'go_mod'],
        ['Gemfile.lock', 'gem', 'pkg:gem/lib@1.0.0', 'lib/1.0.0', 'rubygems'],
        ['composer.lock', 'composer', 'pkg:composer/vendor/lib@1.0.0', 'vendor/lib:1.0.0', 'packagist'],
        ['unknown.lock', 'npm', 'pkg:npm/lib@1.0.0', 'lib/1.0.0', 'npmjs'],
    ])('%s retains module directory, manifest, and package-manager path', (manifest, type, purl, segment, tag) => {
        const file = writeSbom({
            components: [
                {'bom-ref': 'app', type: 'application', name: `apps/client/${manifest}`},
                {'bom-ref': 'dep', purl},
                {'bom-ref': 'other', purl: purl.replace('/lib@', '/other@')},
            ],
            dependencies: [{ref: 'root', dependsOn: ['app']}, {ref: 'app', dependsOn: ['dep', 'other']}],
        })

        const tree = sbomTree(file, 'repo', new Set([type]))

        expect(tree.paths).toHaveLength(2)
        expect(tree.paths).toContainEqual(expect.objectContaining({
            path: `repo/apps/client/-${tag}/${segment}`, projectFilePath: `repo/apps/client/${manifest}`,
            projectPath: 'repo/apps/client', matchType: 'Direct Dependency',
        }))
        expect(tree.paths.map(row => row.projectFilePath)).toEqual([`repo/apps/client/${manifest}`, `repo/apps/client/${manifest}`])
        expect(tree.paths.map(row => row.projectPath)).toEqual(['repo/apps/client', 'repo/apps/client'])
    })

    it.each([
        {scenario: 'shortest chain wins over a longer route', expressChildren: ['b'], chain: 'body-parser/1.20.0'},
        {scenario: 'equally short chains prefer greater parent', expressChildren: ['b', 'c'], chain: 'express/4.18.0'},
    ])('Trivy: $scenario, while graph retains every parent', ({expressChildren, chain}) => {
        const file = writeSbom({
            components: [
                {'bom-ref': 'app', type: 'application', name: 'yarn.lock'},
                {'bom-ref': 'a', purl: 'pkg:npm/express@4.18.0'},
                {'bom-ref': 'b', purl: 'pkg:npm/body-parser@1.20.0'},
                {'bom-ref': 'c', purl: 'pkg:npm/qs@6.10.2'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']}, {ref: 'app', dependsOn: ['a', 'b']},
                {ref: 'a', dependsOn: expressChildren}, {ref: 'b', dependsOn: ['c']},
            ],
        })

        const tree = sbomTree(file, 'demo', new Set(['npm']))

        expect(tree.paths.filter(row => row.name === 'qs')).toEqual([{
            name: 'qs', version: '6.10.2', purlType: 'npm', projectFilePath: 'demo/yarn.lock', projectPath: 'demo',
            matchType: 'Transitive Dependency', path: `demo/-yarn/${chain}/qs/6.10.2`,
        }])
        expect(tree.paths.find(row => row.name === 'body-parser')).toMatchObject({matchType: 'Direct Dependency', path: 'demo/-yarn/body-parser/1.20.0'})
        expect(tree.edges).toContainEqual({repo: 'demo', tree: 'demo/-yarn', purlType: 'npm', parent: 'body-parser/1.20.0', child: 'qs/6.10.2', depth: 2})
    })

    it('composer transitive paths keep vendor names and colon-separated versions', () => {
        const file = writeSbom({
            components: [
                {'bom-ref': 'app', type: 'application', name: 'composer.lock'},
                {'bom-ref': 'a', purl: 'pkg:composer/laravel/fortify@v1.28.0'},
                {'bom-ref': 'b', purl: 'pkg:composer/bacon/bacon-qr-code@v3.0.1'},
            ],
            dependencies: [{ref: 'root', dependsOn: ['app']}, {ref: 'app', dependsOn: ['a']}, {ref: 'a', dependsOn: ['b']}],
        })

        const tree = sbomTree(file, 'php-monica', new Set(['composer']))

        expect(tree.paths.map(row => row.path)).toEqual([
            'php-monica/-packagist/laravel/fortify:v1.28.0',
            'php-monica/-packagist/laravel/fortify:v1.28.0/bacon/bacon-qr-code:v3.0.1',
        ])
    })

    it.each([
        ['go.mod', 'golang', 'pkg:golang/github.com/caddyserver/caddy/v2', 'pkg:golang/github.com/caddyserver/certmagic@v0.25.4', 'demo/-go_mod/github.com/caddyserver/certmagic:v0.25.4', 'demo'],
        ['fuzz/Cargo.lock', 'cargo', 'pkg:cargo/fuzz@0.0.1', 'pkg:cargo/libfuzzer-sys@0.4.7', 'demo/fuzz/-cargo/libfuzzer-sys/0.4.7', 'demo/fuzz'],
    ])('%s omits the project artifact from direct dependency paths', (manifest, type, ownPurl, purl, expected, projectPath) => {
        const file = writeSbom({
            components: [
                {'bom-ref': 'app', type: 'application', name: manifest},
                {'bom-ref': 'own', purl: ownPurl}, {'bom-ref': 'dep', purl},
            ],
            dependencies: [{ref: 'root', dependsOn: ['app']}, {ref: 'app', dependsOn: ['own']}, {ref: 'own', dependsOn: ['dep']}],
        })

        const tree = sbomTree(file, 'demo', new Set([type]))

        expect(tree.paths).toEqual([expect.objectContaining({
            path: expected, projectFilePath: `demo/${manifest}`, projectPath, matchType: 'Direct Dependency',
        })])
    })

    it('Syft workspaces anchor their chains, with unreachable packages at their own manifest roots', () => {
        const file = writeSbom({
            metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [
                {'bom-ref': 'ws', name: '@mastodon/mastodon', version: '0.0.0-use.local',
                    purl: 'pkg:npm/%40mastodon/mastodon@0.0.0-use.local', properties: location('/yarn.lock')},
                {'bom-ref': 'a', purl: 'pkg:npm/vite@7.3.1', properties: location('/yarn.lock')},
                {'bom-ref': 'b', purl: 'pkg:npm/rollup@4.60.1', properties: location('/yarn.lock')},
                {'bom-ref': 'c', purl: 'pkg:npm/cacheable@2.3.4', properties: location('/yarn.lock')},
                {'bom-ref': 'g', purl: 'pkg:gem/nokogiri@1.13.8', properties: location('/Gemfile.lock')},
            ],
            dependencies: [{ref: 'ws', dependsOn: ['a']}, {ref: 'a', dependsOn: ['b']}],
        })

        const tree = sbomTree(file, 'demo', new Set(['npm', 'gem']))

        expect(tree.paths.map(row => [row.matchType, row.path])).toEqual([
            ['Direct Dependency', 'demo/-yarn/vite/7.3.1'], ['Transitive Dependency', 'demo/-yarn/vite/7.3.1/rollup/4.60.1'],
            ['Direct Dependency', 'demo/-yarn/cacheable/2.3.4'], ['Direct Dependency', 'demo/-rubygems/nokogiri/1.13.8'],
        ])
    })

    it('Syft without a workspace keeps transitive chains and all graph edges, including alternate parents', () => {
        const file = writeSbom({
            metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [
                {'bom-ref': 'a', purl: 'pkg:npm/supertest@7.2.2', properties: location('/package-lock.json')},
                {'bom-ref': 'b', purl: 'pkg:npm/superagent@10.2.3', properties: location('/package-lock.json')},
                {'bom-ref': 'c', purl: 'pkg:npm/formidable@3.5.4', properties: location('/package-lock.json')},
                {'bom-ref': 'd', purl: 'pkg:npm/dezalgo@1.0.4', properties: location('/package-lock.json')},
            ],
            dependencies: [{ref: 'a', dependsOn: ['b', 'c']}, {ref: 'b', dependsOn: ['c']}, {ref: 'c', dependsOn: ['d']}],
        })

        const tree = sbomTree(file, 'demo', new Set(['npm']))

        expect(tree.paths.map(row => [row.matchType, row.path])).toEqual([
            ['Direct Dependency', 'demo/-npm/supertest/7.2.2'],
            ['Transitive Dependency', 'demo/-npm/supertest/7.2.2/superagent/10.2.3'],
            ['Transitive Dependency', 'demo/-npm/supertest/7.2.2/formidable/3.5.4'],
            ['Transitive Dependency', 'demo/-npm/supertest/7.2.2/formidable/3.5.4/dezalgo/1.0.4'],
        ])
        expect(tree.edges).toEqual([
            {repo: 'demo', tree: 'demo/-npm', purlType: 'npm', parent: '(root)', child: 'supertest/7.2.2', depth: 1},
            {repo: 'demo', tree: 'demo/-npm', purlType: 'npm', parent: 'supertest/7.2.2', child: 'superagent/10.2.3', depth: 2},
            {repo: 'demo', tree: 'demo/-npm', purlType: 'npm', parent: 'supertest/7.2.2', child: 'formidable/3.5.4', depth: 2},
            {repo: 'demo', tree: 'demo/-npm', purlType: 'npm', parent: 'superagent/10.2.3', child: 'formidable/3.5.4', depth: 2},
            {repo: 'demo', tree: 'demo/-npm', purlType: 'npm', parent: 'formidable/3.5.4', child: 'dezalgo/1.0.4', depth: 3},
        ])
    })

    it('missing manifest location falls back to the registry path tag', () => {
        const file = writeSbom({metadata: {component: {'bom-ref': 'root', type: 'file'}},
            components: [{'bom-ref': 'a', purl: 'pkg:gem/nokogiri@1.13.8'}]})

        const tree = sbomTree(file, 'demo', new Set(['gem']))

        expect(tree.paths).toMatchObject([{path: 'demo/-rubygems/nokogiri/1.13.8'}])
    })
})
