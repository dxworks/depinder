import fs from 'fs'
import os from 'os'
import path from 'path'
import {blackDuckPrefix, manifestOfTree, ownCodeMatcher, pep440, readRepoManifests} from '../src/blackduck/manifests'
import {sbomPaths} from '../src/blackduck/paths'

/**
 * The two things `Path` takes from the scanned repository rather than from the SBOM: Black Duck's
 * project prefix, and which components are the repository's own code. Both are read off the
 * reference export `zzy-v050-split-output`; the shapes asserted here are the ones it contains.
 */

let root: string
const files: string[] = []

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-manifests-'))
})

afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
    for (const file of files.splice(0)) fs.rmSync(file, {force: true})
})

function put(relative: string, content: string | object): void {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
}

function sbom(bom: object): string {
    const file = path.join(os.tmpdir(), `manifests-${process.pid}-${files.length}.cdx.json`)
    fs.writeFileSync(file, JSON.stringify(bom))
    files.push(file)
    return file
}

describe('readRepoManifests', () => {
    it('reads name and version off every manifest family, and records which directories hold a lockfile', () => {
        put('package.json', {name: 'n8n-monorepo', version: '2.37.0', private: true})
        put('pnpm-lock.yaml', '')
        put('packages/cli/package.json', {name: 'n8n', version: '2.37.0'})
        put('.github/scripts/package.json', {name: 'workflow-scripts'})
        put('.github/scripts/pnpm-lock.yaml', '')
        put('pyproject.toml', '[project]\nname = "saleor"\nversion = "3.24.0-a.0"\n\n[tool.uv]\ndev = true\n')
        put('uv.lock', '')
        put('Cargo.toml', '[package]\nname = "ripgrep"\nversion = "15.2.0"  #:version\n\n[[bin]]\nname = "rg"\n')
        put('go.mod', 'module github.com/caddyserver/caddy/v2\n\ngo 1.22\n')
        put('src/PublicApi/PublicApi.csproj', '<Project/>')
        put('node_modules/left-pad/package.json', {name: 'left-pad', version: '1.3.0'})
        const repo = readRepoManifests(root)
        expect(repo?.manifests.map(m => [m.dir, m.purlType, m.name, m.version])).toEqual([
            ['', 'cargo', 'ripgrep', '15.2.0'],
            ['', 'golang', 'github.com/caddyserver/caddy/v2', undefined],
            ['', 'npm', 'n8n-monorepo', '2.37.0'],
            ['', 'pypi', 'saleor', '3.24.0-a.0'],
            ['.github/scripts', 'npm', 'workflow-scripts', undefined],
            ['packages/cli', 'npm', 'n8n', '2.37.0'],
            ['src/PublicApi', 'nuget', 'PublicApi', undefined],
        ])
        // Cargo.toml without a Cargo.lock: a manifest, but not a tree.
        expect([...repo?.lockDirs ?? []].sort()).toEqual([
            'golang\0', 'npm\0', 'npm\0.github/scripts', 'nuget\0src/PublicApi', 'pypi\0',
        ].sort())
    })

    it('takes a POM\'s own coordinates before its parent\'s, and never a dependency\'s', () => {
        put('pom.xml', `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>4.1.0</version>
  </parent>
  <groupId>org.springframework.samples</groupId>
  <artifactId>spring-petclinic</artifactId>
  <version>4.0.0-SNAPSHOT</version>
  <dependencies><dependency><groupId>x</groupId><artifactId>y</artifactId><version>1</version></dependency></dependencies>
</project>`)
        put('module/pom.xml', `<project>
  <parent><groupId>com.acme</groupId><artifactId>parent</artifactId><version>2.0</version></parent>
  <artifactId>child</artifactId>
</project>`)
        const manifests = readRepoManifests(root)?.manifests
        expect(manifests?.map(m => [m.name, m.version])).toEqual([
            ['org.springframework.samples:spring-petclinic', '4.0.0-SNAPSHOT'],
            ['com.acme:child', '2.0'],
        ])
    })

    it('names a Gradle build after rootProject.name, or after nothing', () => {
        put('build.gradle', 'plugins { id "java" }\nversion = "1.2.3"\n')
        put('settings.gradle', "rootProject.name = 'teammates'\n")
        // teammates: the only `version` is a plugin's, inside a block — Black Duck writes `unspecified`.
        put('other/build.gradle.kts', 'plugins { java }\ndependencies {\n    version = "9-0-0-beta-7"\n}\n')
        const manifests = readRepoManifests(root)?.manifests
        expect(manifests?.map(m => [m.dir, m.name, m.version])).toEqual([
            ['', 'teammates', '1.2.3'],
            ['other', undefined, undefined],
        ])
    })

    it('is undefined for a path that is not a directory', () => {
        expect(readRepoManifests(path.join(root, 'nope'))).toBeUndefined()
    })
})

describe('blackDuckPrefix', () => {
    const manifest = (name?: string, version?: string, file = 'package.json') => ({dir: '', file, purlType: 'npm', name, version})

    it('writes the plain directory when there is no manifest to read', () => {
        expect(blackDuckPrefix('pnpm', 'js-pnpm-n8n', undefined)).toBe('js-pnpm-n8n/')
        expect(blackDuckPrefix('gradle', 'java-gradle-teammates', undefined)).toBe('java-gradle-teammates/')
    })

    // Each line is one prefix of the reference export, and the manifest that produced it.
    it('reproduces the reference export, tag by tag', () => {
        expect(blackDuckPrefix('pnpm', 'js-pnpm-n8n', manifest('n8n-monorepo', '2.37.0'))).toBe('n8n-monorepo/2.37.0/js-pnpm-n8n/')
        expect(blackDuckPrefix('pnpm', 'js-pnpm-n8n/.github/scripts', manifest('workflow-scripts'))).toBe('./js-pnpm-n8n/.github/scripts/')
        expect(blackDuckPrefix('npm', 'js-npm-nest/tools/benchmarks', manifest('@nestjs/benchmarks', '1.0.0'))).toBe('@nestjs/benchmarks/1.0.0/js-npm-nest/tools/benchmarks/')
        expect(blackDuckPrefix('npm', 'java-gradle-teammates/docs', manifest('teammates-dev-docs'))).toBe('teammates-dev-docs/java-gradle-teammates/docs/')
        expect(blackDuckPrefix('npm', 'python-saleor', manifest('saleor', '3.24.0-a.0'))).toBe('saleor/3.24.0-a.0/python-saleor/')
        expect(blackDuckPrefix('yarn', 'js-yarn-excalidraw', manifest('excalidraw-monorepo'))).toBe('js-yarn-excalidraw/')
        expect(blackDuckPrefix('yarn', 'js-yarn-excalidraw/dev-docs', manifest('docs', '0.0.0'))).toBe('js-yarn-excalidraw/dev-docs/')
        expect(blackDuckPrefix('uv', 'python-saleor', {dir: '', file: 'pyproject.toml', purlType: 'pypi', name: 'saleor', version: '3.24.0-a.0'})).toBe('saleor/3.24.0a0/python-saleor/')
        expect(blackDuckPrefix('nuget', 'dotnet-eshoponweb/src/PublicApi', {dir: 'src/PublicApi', file: 'PublicApi.csproj', purlType: 'nuget', name: 'PublicApi'})).toBe('PublicApi/dotnet-eshoponweb/src/PublicApi/PublicApi.csproj/')
        expect(blackDuckPrefix('maven', 'java-maven-spring-petclinic', {dir: '', file: 'pom.xml', purlType: 'maven', name: 'org.springframework.samples:spring-petclinic', version: '4.0.0-SNAPSHOT'})).toBe('org.springframework.samples:spring-petclinic:4.0.0-SNAPSHOT:java-maven-spring-petclinic:')
        expect(blackDuckPrefix('gradle', 'java-gradle-teammates', {dir: '', file: 'build.gradle', purlType: 'maven'})).toBe('java-gradle-teammates:unspecified:')
        expect(blackDuckPrefix('go_mod', 'go-caddy', {dir: '', file: 'go.mod', purlType: 'golang', name: 'github.com/caddyserver/caddy/v2'})).toBe('github.com/caddyserver/caddy/v2:go-caddy:')
        expect(blackDuckPrefix('cargo', 'rust-ripgrep', {dir: '', file: 'Cargo.toml', purlType: 'cargo', name: 'ripgrep', version: '15.2.0'})).toBe('rust-ripgrep/')
        expect(blackDuckPrefix('rubygems', 'ruby-mastodon', {dir: '', file: 'Gemfile', purlType: 'gem'})).toBe('ruby-mastodon/')
    })

    it('picks the POM or the Gradle script by the tag when a directory has both', () => {
        put('pom.xml', '<project><groupId>g</groupId><artifactId>a</artifactId><version>1</version></project>')
        put('build.gradle', 'version = "2"\n')
        const repo = readRepoManifests(root)
        expect(manifestOfTree(repo, '', 'maven')?.file).toBe('pom.xml')
        expect(manifestOfTree(repo, '', 'gradle')?.file).toBe('build.gradle')
    })
})

describe('pep440', () => {
    it('normalises the spellings a pyproject may use to what uv.lock and the SBOM carry', () => {
        expect(pep440('3.24.0-a.0')).toBe('3.24.0a0')
        expect(pep440('1.0.0-beta.2')).toBe('1.0.0b2')
        expect(pep440('1.0-preview.3')).toBe('1.0rc3')
        expect(pep440('1.0rc1')).toBe('1.0rc1')
        expect(pep440('2.0.post1')).toBe('2.0.post1')
        expect(pep440('1.0-dev3')).toBe('1.0.dev3')
        expect(pep440('1.2.3')).toBe('1.2.3')
    })
})

describe('ownCodeMatcher', () => {
    it('claims what a manifest inside the tree declares, but not what sits inside a nested tree', () => {
        // nest: `@nestjs/core` is own code of the root lockfile and a real dependency of tools/benchmarks.
        put('package.json', {name: '@nestjs/core', version: '12.0.0', workspaces: ['packages/*']})
        put('package-lock.json', '{}')
        put('packages/common/package.json', {name: '@nestjs/common', version: '12.0.0'})
        put('tools/benchmarks/package.json', {name: '@nestjs/benchmarks', version: '1.0.0'})
        put('tools/benchmarks/package-lock.json', '{}')
        const repo = readRepoManifests(root)
        const rootTree = ownCodeMatcher(repo, '', 'npm')
        const benchmarks = ownCodeMatcher(repo, 'tools/benchmarks', 'npm')
        const core = {type: 'npm', name: '@nestjs/core', version: '12.0.0'}
        const common = {type: 'npm', name: '@nestjs/common', version: '12.0.0'}
        const bench = {type: 'npm', name: '@nestjs/benchmarks', version: '1.0.0'}
        expect([core, common, bench].map(rootTree)).toEqual([true, true, false])
        expect([core, common, bench].map(benchmarks)).toEqual([false, false, true])
        // A published 11.x of the same name is a dependency, not the workspace.
        expect(rootTree({type: 'npm', name: '@nestjs/common', version: '11.0.0'})).toBe(false)
        expect(rootTree({type: 'pypi', name: '@nestjs/common', version: '12.0.0'})).toBe(false)
    })

    it('matches a version-less manifest by name, and a pypi project by its normalised name and version', () => {
        put('package.json', {name: 'excalidraw-monorepo', private: true})
        put('pyproject.toml', '[project]\nname = "Saleor"\nversion = "3.24.0-a.0"\n')
        const repo = readRepoManifests(root)
        expect(ownCodeMatcher(repo, '', 'npm')({type: 'npm', name: 'excalidraw-monorepo', version: '0.0.0'})).toBe(true)
        expect(ownCodeMatcher(repo, '', 'pypi')({type: 'pypi', name: 'saleor', version: '3.24.0a0'})).toBe(true)
        expect(ownCodeMatcher(repo, '', 'pypi')({type: 'pypi', name: 'saleor', version: '3.23.0'})).toBe(false)
        expect(ownCodeMatcher(undefined, '', 'npm')({type: 'npm', name: 'excalidraw-monorepo', version: '0.0.0'})).toBe(false)
    })
})

describe('sbomPaths with the repository on disk', () => {
    // excalidraw dev-docs: Trivy chains `docs@0.0.0 -> @docusaurus/core -> eta`; Black Duck writes
    // `js-yarn-excalidraw/dev-docs/-yarn/@docusaurus/core/2.2.0/eta/1.12.3` — the workspace is
    // the project, and `@docusaurus/core` is Direct.
    it('drops the workspace member from the chain and has no row for it', () => {
        put('package.json', {name: 'excalidraw-monorepo', private: true})
        put('yarn.lock', '')
        put('dev-docs/package.json', {name: 'docs', version: '0.0.0', private: true})
        put('dev-docs/yarn.lock', '')
        const file = sbom({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'dev-docs/yarn.lock'},
                {'bom-ref': 'docs', name: 'docs', version: '0.0.0', purl: 'pkg:npm/docs@0.0.0'},
                {'bom-ref': 'core', name: '@docusaurus/core', version: '2.2.0', purl: 'pkg:npm/%40docusaurus/core@2.2.0'},
                {'bom-ref': 'eta', name: 'eta', version: '1.12.3', purl: 'pkg:npm/eta@1.12.3'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['docs']},
                {ref: 'docs', dependsOn: ['core']},
                {ref: 'core', dependsOn: ['eta']},
            ],
        })
        const withoutRepo = sbomPaths(file, 'js-yarn-excalidraw', new Set(['npm']))
        expect(withoutRepo.map(it => [it.path, it.matchType])).toEqual([
            ['js-yarn-excalidraw/dev-docs/-yarn/docs/0.0.0', 'Direct Dependency'],
            ['js-yarn-excalidraw/dev-docs/-yarn/docs/0.0.0/@docusaurus/core/2.2.0', 'Transitive Dependency'],
            ['js-yarn-excalidraw/dev-docs/-yarn/docs/0.0.0/@docusaurus/core/2.2.0/eta/1.12.3', 'Transitive Dependency'],
        ])
        const withRepo = sbomPaths(file, 'js-yarn-excalidraw', new Set(['npm']), {repoDir: root})
        expect(withRepo.map(it => [it.path, it.matchType, it.projectPath])).toEqual([
            ['js-yarn-excalidraw/dev-docs/-yarn/@docusaurus/core/2.2.0', 'Direct Dependency', 'js-yarn-excalidraw/dev-docs'],
            ['js-yarn-excalidraw/dev-docs/-yarn/@docusaurus/core/2.2.0/eta/1.12.3', 'Transitive Dependency', 'js-yarn-excalidraw/dev-docs'],
        ])
    })

    // saleor: the uv project is the chain's first segment in both tools' SBOMs; Black Duck's
    // prefix is `saleor/3.24.0a0/…/-uv/` and the chain starts at the real dependency.
    it('writes the project prefix and starts the chain after the project itself', () => {
        put('pyproject.toml', '[project]\nname = "saleor"\nversion = "3.24.0-a.0"\n')
        put('uv.lock', '')
        const file = sbom({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'uv.lock'},
                {'bom-ref': 'saleor', name: 'saleor', version: '3.24.0a0', purl: 'pkg:pypi/saleor@3.24.0a0'},
                {'bom-ref': 'stubs', name: 'django-stubs', version: '5.2.2', purl: 'pkg:pypi/django-stubs@5.2.2'},
                {'bom-ref': 'yaml', name: 'types-pyyaml', version: '6.0.12', purl: 'pkg:pypi/types-pyyaml@6.0.12'},
            ],
            dependencies: [
                {ref: 'root', dependsOn: ['app']},
                {ref: 'app', dependsOn: ['saleor']},
                {ref: 'saleor', dependsOn: ['stubs']},
                {ref: 'stubs', dependsOn: ['yaml']},
            ],
        })
        const paths = sbomPaths(file, 'python-saleor', new Set(['pypi']), {repoDir: root})
        expect(paths.map(it => [it.path, it.matchType])).toEqual([
            ['saleor/3.24.0a0/python-saleor/-uv/django-stubs/5.2.2', 'Direct Dependency'],
            ['saleor/3.24.0a0/python-saleor/-uv/django-stubs/5.2.2/types-pyyaml/6.0.12', 'Transitive Dependency'],
        ])
    })

    it('leaves the plain prefix and the full chain when the repository is not on disk', () => {
        const file = sbom({
            metadata: {component: {'bom-ref': 'root'}},
            components: [
                {'bom-ref': 'app', type: 'application', name: 'pnpm-lock.yaml'},
                {'bom-ref': 'zx', name: 'zx', version: '8.8.5', purl: 'pkg:npm/zx@8.8.5'},
            ],
            dependencies: [{ref: 'root', dependsOn: ['app']}, {ref: 'app', dependsOn: ['zx']}],
        })
        expect(sbomPaths(file, 'js-pnpm-n8n', new Set(['npm']), {repoDir: path.join(root, 'missing')}).map(it => it.path))
            .toEqual(['js-pnpm-n8n/-pnpm/zx/8.8.5'])
    })
})
