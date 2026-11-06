import fs from 'fs'
import os from 'os'
import path from 'path'
import {Writable} from 'stream'
import {format, transports} from 'winston'
import {parse} from 'csv-parse/sync'
import {writeBlackDuckForSource} from '../src/blackduck/run'
import {describeSbom} from '../src/plugins/sbom/describe'
import {parseCycloneDxFile} from '../src/plugins/sbom/cyclonedx'
import {log} from '../src/utils/logging'

let folder: string
let warnings: string[]
let warningTransport: transports.StreamTransportInstance

beforeEach(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-path-fallback-'))
    warnings = []
    warningTransport = new transports.Stream({
        level: 'warn', format: format.printf(info => String(info.message)),
        stream: new Writable({write(chunk, _encoding, done) { warnings.push(chunk.toString().trim()); done() }}),
    })
    log.add(warningTransport)
})

afterEach(() => {
    log.remove(warningTransport)
    warningTransport.destroy()
    fs.rmSync(folder, {recursive: true, force: true})
})

const csv = (file: string): Record<string, string>[] =>
    parse(fs.readFileSync(path.join(folder, 'out', file), 'utf8'), {columns: true})

function writeSbom(dependencies: {ref: string, dependsOn: string[]}[], module = 'module'): string {
    const file = path.join(folder, `${module}.cdx.json`)
    const location = [{name: 'syft:location:0:path', value: `/${module}/uv.lock`}]
    fs.writeFileSync(file, JSON.stringify({
        metadata: {component: {'bom-ref': 'root', type: 'file', name: 'sample-repo'}},
        components: [
            {'bom-ref': 'entry', purl: 'pkg:pypi/entry@1.0.0', properties: location},
            {'bom-ref': 'a', purl: 'pkg:pypi/library-a@1.0.0', properties: location},
            {'bom-ref': 'b', purl: 'pkg:pypi/library-b@2.0.0', properties: location},
            {'bom-ref': 'leaf', purl: 'pkg:pypi/leaf@3.0.0', properties: location},
            {'bom-ref': 'flat', purl: 'pkg:pypi/flat@4.0.0', properties: location},
        ],
        dependencies,
    }))
    return file
}

function exportReports(...files: string[]): void {
    writeBlackDuckForSource(files.map(describeSbom), [
        {purlType: 'pypi', projects: files.flatMap(file => parseCycloneDxFile(file, 'pypi'))},
    ], path.join(folder, 'out'), folder, {depminerIndex: false})
}

describe('dependency path fallback diagnostics', () => {
    it.each([
        {scenario: 'no requesters', requestedBy: [], match: 'Direct'},
        {scenario: 'project requester', requestedBy: ['module@unknown'], match: 'Direct'},
        {scenario: 'library requester', requestedBy: ['entry@1.0.0'], match: 'Transitive'},
        {scenario: 'mixed requesters', requestedBy: ['module@unknown', 'entry@1.0.0'], match: 'Direct,Transitive'},
    ])('uses $scenario when the graph is unavailable', ({requestedBy, match}) => {
        const file = writeSbom([])
        const sbom = describeSbom(file)
        const projects = parseCycloneDxFile(file, 'pypi')
        projects[0].dependencies['library-a@1.0.0'].requestedBy = requestedBy
        fs.rmSync(file)

        writeBlackDuckForSource([sbom], [{purlType: 'pypi', projects}],
            path.join(folder, 'out'), folder, {depminerIndex: false})

        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'library-a', 'Match type': match,
        }))
        expect(csv('_dependencies_sources.csv')).toEqual([])
        expect(warnings).toContainEqual(expect.stringContaining(file))
    })

    it('exports cycle fallback paths as direct while retaining transitive component usage without warnings', () => {
        const file = writeSbom([
            {ref: 'a', dependsOn: ['b']}, {ref: 'b', dependsOn: ['a', 'leaf']},
        ])

        exportReports(file)

        expect(warnings).toEqual([])
        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({'Component name': 'library-a', 'Match type': 'Direct,Transitive'}))
        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({'Component name': 'library-b', 'Match type': 'Direct,Transitive'}))
        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({'Component name': 'leaf', 'Match type': 'Direct,Transitive'}))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({'Component name': 'library-a', 'Match type': 'Direct'}))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({'Component name': 'leaf', 'Match type': 'Direct'}))
    })

    it('does not warn about cycles reachable from an inferred graph root', () => {
        const file = writeSbom([
            {ref: 'entry', dependsOn: ['a']}, {ref: 'a', dependsOn: ['b']},
            {ref: 'b', dependsOn: ['a', 'leaf']},
        ])

        exportReports(file)

        expect(warnings).toEqual([])
    })

    it('exports flat inventories as direct without a cycle warning', () => {
        const file = writeSbom([])

        exportReports(file)

        expect(warnings).toEqual([])
        expect(csv('_dependencies.csv').map(row => row['Match type'])).toEqual(['Direct', 'Direct', 'Direct', 'Direct', 'Direct'])
        expect(csv('_dependencies_sources.csv').map(row => row['Match type'])).toEqual(['Direct', 'Direct', 'Direct', 'Direct', 'Direct'])
    })

    it('exports isolated packages as direct alongside connected dependencies', () => {
        const file = writeSbom([{ref: 'entry', dependsOn: ['a']}])

        exportReports(file)

        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({'Component name': 'flat', 'Match type': 'Direct'}))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({'Component name': 'flat', 'Match type': 'Direct'}))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({'Component name': 'library-a', 'Match type': 'Transitive'}))
        expect(warnings).toEqual([])
    })

    it('aggregates component usage across fallback paths and connected projects', () => {
        const disconnected = writeSbom([
            {ref: 'a', dependsOn: ['b']}, {ref: 'b', dependsOn: ['a']},
        ])
        const connected = writeSbom([{ref: 'a', dependsOn: ['b']}], 'connected')

        exportReports(disconnected, connected)

        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({'Component name': 'library-a', 'Match type': 'Direct,Transitive'}))
        expect(csv('_dependencies.csv')).toContainEqual(expect.objectContaining({'Component name': 'library-b', 'Match type': 'Direct,Transitive'}))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'library-a', 'ProjectFilePath': 'sample-repo/module/uv.lock', 'Match type': 'Direct',
        }))
        expect(csv('_dependencies_sources.csv')).toContainEqual(expect.objectContaining({
            'Component name': 'library-a', 'ProjectFilePath': 'sample-repo/connected/uv.lock', 'Match type': 'Direct',
        }))
    })

    it('reports direct fallback usage in vulnerability details', () => {
        const file = writeSbom([
            {ref: 'a', dependsOn: ['b']}, {ref: 'b', dependsOn: ['a']},
        ])
        const projects = parseCycloneDxFile(file, 'pypi')
        projects[0].dependencies['library-a@1.0.0'].vulnerabilities = [{
            severity: 'HIGH', score: 8, description: 'Sample advisory',
            permalink: 'https://example.test/advisory', identifiers: [{type: 'GHSA', value: 'GHSA-aaaa-bbbb-cccc'}],
        }]

        writeBlackDuckForSource([describeSbom(file)], [{purlType: 'pypi', projects}],
            path.join(folder, 'out'), folder, {depminerIndex: false})

        expect(csv('_vulnerability_details.csv')).toMatchObject([{'Component name': 'library-a', 'Match type': 'Direct Dependency'}])
    })
})
