import fs from 'fs'
import os from 'os'
import path from 'path'
import {depMinerManifests, readDepMinerIndex} from '../src/blackduck/depminer-index'
import {parseCycloneDxFile, readBomGraph} from '../src/plugins/sbom/cyclonedx'
import {SbomDescription} from '../src/plugins/sbom/describe'

/**
 * DepMiner and Syft record paths in the scanned repository's own spelling. A scan run on
 * Windows yields `repo\package.json` index values and `services\alpha\pom.xml` Syft locations;
 * both must behave exactly as the `/`-spelt Linux originals. Refs, purls and properties that
 * are not paths stay verbatim.
 */

let tmpDir: string

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-win-paths-'))
})

afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

function write(relative: string, content: string | object): string {
    const file = path.join(tmpDir, relative)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
}

function sbom(repo: string): SbomDescription {
    return {file: path.join(tmpDir, 'syft', `${repo}.cdx.json`), producer: 'syft', repo, repoFromMetadata: true, purlTypes: new Set(['npm'])}
}

/** DepMiner's `index.json` as a Windows scan writes it: `\` values, sometimes mixed with `/`. */
describe('readDepMinerIndex - Windows-spelt index values', () => {
    beforeEach(() => {
        write('depminer/package-0.json', {name: 'root-app', version: '1.0.0'})
        write('depminer/package-1.json', {name: 'nested-app', version: '2.0.0'})
        write('depminer/pnpm-lock.yaml', '')
        write('depminer/index.json', {
            'package-0.json': 'win-repo\\package.json',
            'package-1.json': 'win-repo/nested\\package.json',
            'pnpm-lock.yaml': 'win-repo\\pnpm-lock.yaml',
        })
        write('syft/win-repo.cdx.json', {})
    })

    it('keys each copy by its slash-separated path inside the repository', () => {
        const repos = readDepMinerIndex(path.join(tmpDir, 'depminer', 'index.json'))
        expect([...repos.keys()]).toEqual(['win-repo'])
        expect([...repos.get('win-repo') ?? []]).toEqual([
            ['package.json', path.join(tmpDir, 'depminer', 'package-0.json')],
            ['nested/package.json', path.join(tmpDir, 'depminer', 'package-1.json')],
            ['pnpm-lock.yaml', path.join(tmpDir, 'depminer', 'pnpm-lock.yaml')],
        ])
    })

    it('reads the repository\'s manifests and lock dirs off the normalised paths', () => {
        const manifests = depMinerManifests(undefined, tmpDir)(sbom('win-repo'))
        expect(manifests?.manifests.map(m => [m.dir, m.name, m.version])).toEqual([
            ['', 'root-app', '1.0.0'],
            ['nested', 'nested-app', '2.0.0'],
        ])
        expect([...manifests?.lockDirs ?? []]).toEqual(['npm\0'])
    })
})

const loc = (index: number, p: string) => ({name: `syft:location:${index}:path`, value: p})

/**
 * A Syft SBOM written on Windows is still flat: the root `file` node has no edges, and module
 * boundaries live in `syft:location:*:path` - here spelt `\services\alpha\pom.xml`, once even
 * mixed `\services/beta\pom.xml`. The alpha module's bom-ref itself contains a backslash and
 * every edge that mentions it spells it identically: refs are identities, not paths.
 */
const syftWindowsMavenBom = {
    metadata: {component: {'bom-ref': 'root-hash', type: 'file', name: 'D:\\src\\winmono'}},
    components: [
        {
            'bom-ref': 'anchor\\alpha', type: 'library', name: 'alpha', version: '1.0.0',
            purl: 'pkg:maven/org.example/alpha@1.0.0',
            properties: [
                loc(0, '\\services\\alpha\\pom.xml'),
                {name: 'scan:root', value: 'D:\\src\\winmono'},
            ],
        },
        {
            'bom-ref': 'anchor-beta', type: 'library', name: 'beta', version: '1.0.0',
            purl: 'pkg:maven/org.example/beta@1.0.0',
            properties: [loc(0, '\\services/beta\\pom.xml')],
        },
        {
            'bom-ref': 'dep-guava', type: 'library', name: 'guava', version: '1.0.0',
            purl: 'pkg:maven/com.google.guava/guava@1.0.0',
            properties: [loc(0, '\\services\\alpha\\pom.xml')],
        },
        {
            'bom-ref': 'dep-gson', type: 'library', name: 'gson', version: '2.0.0',
            purl: 'pkg:maven/com.google.code.gson/gson@2.0.0',
            properties: [loc(0, '\\services/beta\\pom.xml')],
        },
    ],
    dependencies: [
        {ref: 'anchor\\alpha', dependsOn: ['dep-guava']},
        {ref: 'anchor-beta', dependsOn: ['anchor\\alpha', 'dep-gson']},
    ],
}

describe('parseCycloneDxFile - Syft maven modules recorded with Windows separators', () => {
    it('reconstructs one project per module, on canonical /-separated paths', () => {
        const projects = parseCycloneDxFile(write('winmono.cdx.json', syftWindowsMavenBom), 'maven')
        expect(projects.map(p => p.name).sort()).toEqual(['services/alpha', 'services/beta'])
        expect(projects.map(p => p.path).sort()).toEqual(['services/alpha/pom.xml', 'services/beta/pom.xml'])
        expect(projects.map(p => p.version)).toEqual(['1.0.0', '1.0.0'])
    })

    it('keeps each module\'s own anchor out and another module\'s artifact in as a real dep', () => {
        const projects = parseCycloneDxFile(write('winmono2.cdx.json', syftWindowsMavenBom), 'maven')
        const alpha = projects.find(p => p.name === 'services/alpha')!
        const beta = projects.find(p => p.name === 'services/beta')!
        expect(Object.keys(alpha.dependencies)).toEqual(['com.google.guava:guava@1.0.0'])
        expect(alpha.dependencies['com.google.guava:guava@1.0.0'].requestedBy).toEqual(['services/alpha@1.0.0'])
        // beta declares alpha's artifact directly and reaches guava only through it.
        expect(Object.keys(beta.dependencies).sort()).toEqual([
            'com.google.code.gson:gson@2.0.0',
            'com.google.guava:guava@1.0.0',
            'org.example:alpha@1.0.0',
        ])
        expect(beta.dependencies['org.example:alpha@1.0.0'].requestedBy).toEqual(['services/beta@1.0.0'])
        expect(beta.dependencies['com.google.code.gson:gson@2.0.0'].requestedBy).toEqual(['services/beta@1.0.0'])
        expect(beta.dependencies['com.google.guava:guava@1.0.0'].requestedBy).toEqual(['org.example:alpha@1.0.0'])
    })

    it('normalises only the location paths: refs, edges and other properties stay verbatim', () => {
        const graph = readBomGraph(write('winmono3.cdx.json', syftWindowsMavenBom))
        const anchor = graph.byRef.get('anchor\\alpha')
        expect(anchor).toBeDefined()
        expect(anchor?.properties).toEqual([
            {name: 'syft:location:0:path', value: '/services/alpha/pom.xml'},
            {name: 'scan:root', value: 'D:\\src\\winmono'},
        ])
        expect(graph.edges.get('anchor\\alpha')).toEqual(['dep-guava'])
        expect(graph.edges.get('anchor-beta')).toEqual(['anchor\\alpha', 'dep-gson'])
    })
})

describe('parseCycloneDxFile - one npm library seen under several Windows locations', () => {
    it('opens one scoped project per indexed location', () => {
        const bom = {
            metadata: {component: {'bom-ref': 'root-hash', type: 'file', name: 'D:\\src\\winapp'}},
            components: [
                {
                    'bom-ref': 'dep-lodash', type: 'library', name: 'lodash', version: '4.17.21',
                    purl: 'pkg:npm/lodash@4.17.21',
                    properties: [
                        loc(0, '\\one\\package-lock.json'),
                        loc(1, '\\two\\package-lock.json'),
                    ],
                },
            ],
            dependencies: [],
        }
        const projects = parseCycloneDxFile(write('winapp.cdx.json', bom), 'npm')
        expect(projects.map(p => p.path)).toEqual(['one/package-lock.json', 'two/package-lock.json'])
        expect(projects.map(p => p.name)).toEqual(['one', 'two'])
        for (const project of projects) {
            expect(Object.keys(project.dependencies)).toEqual(['lodash@4.17.21'])
        }
    })
})
