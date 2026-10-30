import fs from 'fs'
import os from 'os'
import path from 'path'
import {parse} from 'csv-parse/sync'
import {writeBlackDuckForSource} from '../src/blackduck/run'
import {parseCycloneDxFile} from '../src/plugins/sbom/cyclonedx'
import {describeSbom} from '../src/plugins/sbom/describe'
import {log} from '../src/utils/logging'

let folder: string

beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-source-paths-'))
})

afterEach(() => fs.rmSync(folder, {recursive: true, force: true}))

function writeSbom(producer: string, repo: string, manifest: string): string {
    const file = path.join(folder, `${repo}.cdx.json`)
    const location = [{name: 'syft:location:0:path', value: `/${manifest}`}]
    fs.writeFileSync(file, JSON.stringify({
        bomFormat: 'CycloneDX',
        metadata: {
            tools: [{name: producer}],
            component: {'bom-ref': 'root', type: producer === 'syft' ? 'file' : 'application', name: repo},
        },
        components: [
            ...(producer === 'trivy' ? [{'bom-ref': 'app', type: 'application', name: manifest}] : []),
            {'bom-ref': 'parent', purl: 'pkg:pypi/parent@1.0.0', properties: location},
            {'bom-ref': 'child', purl: 'pkg:pypi/child@2.0.0', properties: location},
        ],
        dependencies: [
            ...(producer === 'trivy' ? [{ref: 'root', dependsOn: ['app']}, {ref: 'app', dependsOn: ['parent']}] : []),
            {ref: 'parent', dependsOn: ['child']},
        ],
    }))
    return file
}

it.each(['trivy', 'syft'])('exports paths from %s', producer => {
    const files = [writeSbom(producer, 'example-app', 'Pipfile.lock'), writeSbom(producer, 'example-service', 'api/Pipfile.lock')]
    const projects = files.flatMap(file => parseCycloneDxFile(file, 'pypi'))
    Object.values(projects[0].dependencies)[0].vulnerabilities = [{
        severity: 'HIGH', score: 8, description: 'test finding', identifiers: [{type: 'CVE', value: 'CVE-2026-0001'}],
        permalink: 'https://example.test/advisory',
    }]

    writeBlackDuckForSource(files.map(describeSbom), [{purlType: 'pypi', projects}], folder, folder)
    const readCsv = (file: string): Record<string, string>[] =>
        parse(fs.readFileSync(path.join(folder, file), 'utf8'), {columns: true})
    const sources = readCsv('_dependencies_sources.csv')

    expect(sources).toHaveLength(4)
    expect(sources.map(row => row.ProjectFilePath)).toEqual([
        'example-app/Pipfile.lock', 'example-app/Pipfile.lock',
        'example-service/api/Pipfile.lock', 'example-service/api/Pipfile.lock',
    ])
    expect(sources.map(row => row.ProjectPath)).toEqual([
        'example-app', 'example-app', 'example-service/api', 'example-service/api',
    ])
    expect(sources.map(row => row.Path)).toEqual([
        'example-app/-pip/parent/1.0.0', 'example-app/-pip/parent/1.0.0/child/2.0.0',
        expect.stringMatching(/^example-service\//), expect.stringMatching(/^example-service\//),
    ])
    expect(readCsv('_dependency_edges.csv').map(row => row.Repo)).toEqual(['example-app', 'example-app', 'example-service', 'example-service'])
    expect(readCsv('_vulnerability_details.csv')[0]).not.toHaveProperty('Project path')
})

it('leaves the project file path empty and keeps the repository directory when the SBOM has no manifest location', () => {
    const file = writeSbom('syft', 'example-app', 'Pipfile.lock')
    const bom = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const component of bom.components) delete component.properties
    fs.writeFileSync(file, JSON.stringify(bom))
    writeBlackDuckForSource([describeSbom(file)], [{purlType: 'pypi', projects: parseCycloneDxFile(file, 'pypi')}], folder, folder)

    const sources: Record<string, string>[] = parse(fs.readFileSync(path.join(folder, '_dependencies_sources.csv'), 'utf8'), {columns: true})
    expect(sources.map(row => row.ProjectPath)).toEqual(['example-app', 'example-app'])
    expect(sources.map(row => row.ProjectFilePath)).toEqual(['', ''])
    expect(parse(fs.readFileSync(path.join(folder, '_vulnerability_details.csv'), 'utf8'), {columns: true})).toHaveLength(0)
})

it.each(['trivy', 'syft'])('filters manifest-declared own code in %s paths while keeping repository prefixes', producer => {
    const dependencyFile = writeSbom(producer, 'example-app', 'uv.lock')
    const emptyFile = path.join(folder, 'example-empty.cdx.json')
    fs.writeFileSync(emptyFile, JSON.stringify({
        bomFormat: 'CycloneDX', metadata: {component: {'bom-ref': 'root', name: 'example-empty'}}, components: [],
    }))
    const harvested = path.join(folder, 'depminer')
    fs.mkdirSync(harvested)
    const manifestFile = path.join(harvested, 'pyproject.toml')
    const manifest = '[project]\nname = "parent"\nversion = "1.0.0"\n'
    fs.writeFileSync(manifestFile, manifest)
    const indexFile = path.join(harvested, 'index.json')
    fs.writeFileSync(indexFile, JSON.stringify({'pyproject.toml': 'example-app/pyproject.toml'}))
    const warning = vi.spyOn(log, 'warn')
    try {
        const descriptions = [describeSbom(dependencyFile), describeSbom(emptyFile)]
        const analysed = [{purlType: 'pypi', projects: parseCycloneDxFile(dependencyFile, 'pypi')}]
        const written = writeBlackDuckForSource(descriptions, analysed, folder, folder)
        expect(written).toContainEqual({file: '_dependencies_sources.csv', rows: 1})
        const rows: Record<string, string>[] = parse(fs.readFileSync(path.join(folder, '_dependencies_sources.csv'), 'utf8'), {columns: true})
        expect(rows.map(row => [row['Component name'], row.Path, row['Match type']])).toEqual([
            ['child', 'example-app/-uv/child/2.0.0', 'Direct'],
        ])
        expect(rows[0].ProjectFilePath).toBe('example-app/uv.lock')
        expect(rows[0].ProjectPath).toBe('example-app')
        const edges = fs.readFileSync(path.join(folder, '_dependency_edges.csv'), 'utf8')
        writeBlackDuckForSource(descriptions, analysed, folder, folder, {depminerIndex: false})
        const unfiltered: Record<string, string>[] = parse(fs.readFileSync(path.join(folder, '_dependencies_sources.csv'), 'utf8'), {columns: true})
        expect(unfiltered.map(row => [row['Component name'], row.Path, row['Match type']])).toEqual([
            ['parent', 'example-app/-uv/parent/1.0.0', 'Direct'],
            ['child', 'example-app/-uv/parent/1.0.0/child/2.0.0', 'Transitive'],
        ])
        expect(fs.readFileSync(path.join(folder, '_dependency_edges.csv'), 'utf8')).toBe(edges)
        expect(fs.readFileSync(manifestFile, 'utf8')).toBe(manifest)
        expect(warning).not.toHaveBeenCalled()
    } finally {
        warning.mockRestore()
    }
})
