import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {writeBlackDuckForSource} from '../src/blackduck/run'
import {describeSbom} from '../src/plugins/sbom/describe'
import {parseCycloneDxFile} from '../src/plugins/sbom/cyclonedx'

let folder: string
beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-match-types-')) })
afterEach(() => fs.rmSync(folder, {recursive: true, force: true}))

const csv = (file: string): Record<string, string>[] =>
    parse(fs.readFileSync(path.join(folder, 'out', file), 'utf8'), {columns: true})

function exportPython(name: string, version: string, otherChildren: string[], indexEnabled = true): void {
    const file = path.join(folder, 'repo.cdx.json')
    const location = [{name: 'syft:location:0:path', value: '/uv.lock'}]
    fs.writeFileSync(file, JSON.stringify({
        metadata: {component: {'bom-ref': 'root', type: 'file', name: 'repo'}},
        components: [
            {'bom-ref': 'own', purl: 'pkg:pypi/sample-app@1.0.0', properties: location},
            {'bom-ref': 'target', purl: `pkg:pypi/${name}@${version}`, properties: location},
            {'bom-ref': 'other', purl: 'pkg:pypi/other@1.0.0', properties: location},
            {'bom-ref': 'leaf', purl: 'pkg:pypi/leaf@2.0.0', properties: location},
        ],
        dependencies: [
            {ref: 'own', dependsOn: ['target', 'other']},
            {ref: 'other', dependsOn: otherChildren},
            {ref: 'target', dependsOn: ['leaf']},
        ],
    }))
    fs.writeFileSync(path.join(folder, 'pyproject.toml'), '[project]\nname = "sample-app"\nversion = "1.0.0"\n')
    fs.writeFileSync(path.join(folder, 'uv.lock'), '')
    const index = path.join(folder, 'index.json')
    fs.writeFileSync(index, JSON.stringify({'pyproject.toml': 'repo/pyproject.toml', 'uv.lock': 'repo/uv.lock'}))
    writeBlackDuckForSource([describeSbom(file)], [
        {purlType: 'pypi', projects: parseCycloneDxFile(file, 'pypi')},
    ], path.join(folder, 'out'), folder, {depminerIndex: indexEnabled ? index : false})
}

describe('component and source dependency classification', () => {
    it.each([
        {name: 'shared-library', version: '2.0.0', otherChildren: ['target'], match: 'Direct,Transitive'},
        {name: 'direct-library', version: '3.0.0', otherChildren: [], match: 'Direct'},
    ])('$name declared by own package retains direct usage and genuine transitive usage', ({name, version, otherChildren, match}) => {
        exportPython(name, version, otherChildren)

        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({
            'Component name': name, 'Component version name': version, 'Match type': match,
        }))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({
            'Component name': name, 'Match type': 'Direct', 'Path': `repo/-uv/${name}/${version}`,
        }))
        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'leaf', 'Match type': 'Transitive',
        }))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'leaf', 'Match type': 'Transitive',
        }))
    })

    it('retains external parent classification when manifests are unavailable', () => {
        exportPython('direct-library', '3.0.0', [], false)

        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'direct-library', 'Match type': 'Transitive',
        }))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'direct-library', 'Match type': 'Transitive',
        }))
    })

    it('aggregates direct and transitive usage across independently owned lockfile trees', () => {
        const file = path.join(folder, 'repo.cdx.json')
        const rootLocation = [{name: 'syft:location:0:path', value: '/uv.lock'}]
        const nestedLocation = [{name: 'syft:location:0:path', value: '/tools/uv.lock'}]
        fs.writeFileSync(file, JSON.stringify({
            metadata: {component: {'bom-ref': 'root', type: 'file', name: 'repo'}},
            components: [
                {'bom-ref': 'own', purl: 'pkg:pypi/app@1.0.0', properties: rootLocation},
                {'bom-ref': 'direct', purl: 'pkg:pypi/shared-library@2.0.0', properties: rootLocation},
                {'bom-ref': 'nested', purl: 'pkg:pypi/tools@1.0.0', properties: nestedLocation},
                {'bom-ref': 'external', purl: 'pkg:pypi/app@1.0.0', properties: nestedLocation},
                {'bom-ref': 'indirect', purl: 'pkg:pypi/shared-library@2.0.0', properties: nestedLocation},
            ],
            dependencies: [
                {ref: 'own', dependsOn: ['direct']}, {ref: 'nested', dependsOn: ['external']},
                {ref: 'external', dependsOn: ['indirect']},
            ],
        }))
        fs.writeFileSync(path.join(folder, 'app.toml'), '[project]\nname = "app"\nversion = "1.0.0"\n')
        fs.writeFileSync(path.join(folder, 'tools.toml'), '[project]\nname = "tools"\nversion = "1.0.0"\n')
        fs.writeFileSync(path.join(folder, 'uv.lock'), '')
        const index = path.join(folder, 'index.json')
        fs.writeFileSync(index, JSON.stringify({
            'app.toml': 'repo/pyproject.toml', 'tools.toml': 'repo/tools/pyproject.toml',
            'uv.lock': 'repo/uv.lock', 'nested.lock': 'repo/tools/uv.lock',
        }))

        writeBlackDuckForSource([describeSbom(file)], [
            {purlType: 'pypi', projects: parseCycloneDxFile(file, 'pypi')},
        ], path.join(folder, 'out'), folder, {depminerIndex: index})

        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'shared-library', 'Match type': 'Direct,Transitive',
        }))
        const sources = csv('_dependencies_sources.csv').filter(row => row['Component name'] === 'shared-library')
        expect(sources).toHaveLength(2)
        expect(sources).toEqual(expect.arrayContaining([
            expect.objectContaining({'ProjectFilePath': 'repo/uv.lock', 'Match type': 'Direct'}),
            expect.objectContaining({'ProjectFilePath': 'repo/tools/uv.lock', 'Match type': 'Transitive'}),
        ]))
    })
})
