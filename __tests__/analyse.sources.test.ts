import fs from 'fs'
import os from 'os'
import path from 'path'
import {classifyInputs, inputFolderOf, NATIVE_SOURCE} from '../src/commands/sources'
import {planRuns} from '../src/commands/analyse'
import {defaultProjectName} from '../src/blackduck/run'
import {clearSbomDescriptions, describeSbom} from '../src/plugins/sbom/describe'
import {getPluginsFromNames} from '../src/plugins'
import {log} from '../src/utils/logging'

/**
 * One `analyse` invocation may point at a folder of Trivy SBOMs, a folder of Syft SBOMs, a
 * checked-out repository, or all three at once — and each source gets its own results subfolder.
 * What decides is the content of each file, so a mixed folder must sort itself out, and a file
 * depinder cannot use must be named and skipped rather than fail the run.
 */

let tmpDir: string
let warnings: string[]
let warnSpy: jest.SpyInstance

const trivyTools = {components: [{type: 'application', name: 'trivy', version: '0.72.0'}]}
const syftTools = {components: [{type: 'application', name: 'syft', version: '1.46.0'}]}

function sbom(tools: unknown, repo: string, purls: string[]): unknown {
    return {
        bomFormat: 'CycloneDX', specVersion: '1.7',
        metadata: {tools, component: {'bom-ref': 'root', type: 'application', name: repo}},
        components: purls.map((purl, i) => ({'bom-ref': `c${i}`, purl})),
    }
}

function write(dir: string, name: string, content: unknown): string {
    fs.mkdirSync(dir, {recursive: true})
    const file = path.join(dir, name)
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))
    return file
}

beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-sources-'))
})

afterAll(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true})
})

beforeEach(() => {
    clearSbomDescriptions()
    warnings = []
    warnSpy = jest.spyOn(log, 'warn').mockImplementation(((message: string) => {
        warnings.push(message)
        return log
    }) as any)
})

afterEach(() => warnSpy.mockRestore())

describe('classifyInputs', () => {
    it('sorts a mixed folder by what each file says about itself', () => {
        const dir = path.join(tmpDir, 'mixed')
        const trivy = write(dir, 'a.json-is-not-the-rule.cdx.json', sbom(trivyTools, 'repo-a', ['pkg:npm/qs@6.10.2']))
        const syft = write(dir, 'repo-a.trivy.cdx.json', sbom(syftTools, 'repo-a', ['pkg:gem/rails@7.0.0']))
        const lock = write(dir, 'package-lock.json', {})
        const other = write(dir, 'notes.txt', 'hello')

        const sources = classifyInputs([syft, lock, trivy, other])

        expect(sources.native).toEqual([lock, other])
        expect(sources.sbom.map(it => it.name)).toEqual(['trivy', 'syft'])
        expect(sources.sbom[0].sboms.map(it => it.file)).toEqual([trivy])
        expect(sources.sbom[1].sboms.map(it => it.file)).toEqual([syft])
        expect(warnings).toEqual([])
    })

    it('warns about and skips a broken SBOM and one from a tool it does not know', () => {
        const dir = path.join(tmpDir, 'skipped')
        const broken = write(dir, 'broken.cdx.json', '{ not json')
        const cdxgen = write(dir, 'gen.cdx.json', sbom({components: [{name: 'cdxgen', version: '10.0'}]}, 'x', []))
        const spdx = write(dir, 'spdx.cdx.json', {spdxVersion: 'SPDX-2.3', packages: []})
        const good = write(dir, 'ok.cdx.json', sbom(trivyTools, 'ok', []))

        const sources = classifyInputs([broken, cdxgen, spdx, good])

        expect(sources.native).toEqual([])
        expect(sources.sbom).toEqual([{name: 'trivy', sboms: [describeSbom(good)]}])
        expect(warnings).toHaveLength(3)
        expect(warnings.find(it => it.startsWith('Skipping broken.cdx.json'))).toBeDefined()
        expect(warnings.find(it => it.startsWith('Skipping gen.cdx.json'))).toContain('written by cdxgen')
        expect(warnings.find(it => it.startsWith('Skipping spdx.cdx.json'))).toContain('not a CycloneDX')
    })

    it('warns when one producer describes the same repo twice, and keeps both', () => {
        const dir = path.join(tmpDir, 'dup')
        const one = write(dir, 'one.cdx.json', sbom(trivyTools, 'repo', []))
        const two = write(dir, 'two.cdx.json', sbom(trivyTools, 'repo', []))
        const syft = write(dir, 'three.cdx.json', sbom(syftTools, 'repo', []))

        const sources = classifyInputs([one, two, syft])

        expect(sources.sbom.find(it => it.name === 'trivy')?.sboms).toHaveLength(2)
        expect(warnings).toEqual([expect.stringContaining('trivy has 2 SBOMs for repo repo: one.cdx.json, two.cdx.json')])
    })

    it('has nothing to say about a folder with no SBOMs', () => {
        const lock = write(path.join(tmpDir, 'native'), 'Gemfile.lock', '')
        expect(classifyInputs([lock])).toEqual({native: [lock], sbom: []})
    })
})

describe('planRuns', () => {
    const results = '/out'

    function inputs() {
        const dir = path.join(tmpDir, 'plan')
        return {
            trivy: write(dir, 't.cdx.json', sbom(trivyTools, 'repo', ['pkg:npm/qs@6.10.2', 'pkg:hex/plug@1.0.0'])),
            syft: write(dir, 's.cdx.json', sbom(syftTools, 'repo', ['pkg:gem/rails@7.0.0'])),
            lock: write(dir, 'package-lock.json', '{}'),
            pom: write(dir, 'pom.xml', '<project/>'),
        }
    }

    it('gives every source its own subfolder, the sbom plugins its ecosystems need and every native plugin', () => {
        const {trivy, syft, lock, pom} = inputs()
        const runs = planRuns(classifyInputs([trivy, syft, lock, pom]), getPluginsFromNames(), {results, refresh: false}, results, [tmpDir])

        expect(runs.map(it => it.source)).toEqual(['trivy', 'syft', NATIVE_SOURCE])
        expect(runs.map(it => it.folder)).toEqual(['/out/trivy', '/out/syft', `/out/${NATIVE_SOURCE}`])
        expect(runs[0].plugins.map(it => it.name)).toEqual(['sbom-npm'])
        expect(runs[0].files).toEqual([trivy])
        expect(runs[0].sboms?.map(it => it.repo)).toEqual(['repo'])
        expect(runs[1].plugins.map(it => it.name)).toEqual(['sbom-ruby'])
        // The native run is every native plugin, files or not: the empty CSVs are part of the output.
        expect(runs[2].plugins.map(it => it.name).sort()).toEqual(['dotnet', 'java', 'npm', 'php', 'python', 'ruby'])
        expect(runs[2].files).toEqual([lock, pom])
        expect(runs[2].sboms).toBeUndefined()
    })

    it('honours an explicit plugin list on both sides', () => {
        const {trivy, syft, lock, pom} = inputs()
        const sources = classifyInputs([trivy, syft, lock, pom])

        const sbomOnly = planRuns(sources, getPluginsFromNames(['sbom-npm']), {results, refresh: false, plugins: ['sbom-npm']}, results, [tmpDir])
        expect(sbomOnly.map(it => [it.source, it.plugins.map(p => p.name)])).toEqual([['trivy', ['sbom-npm']], ['syft', ['sbom-npm']]])

        const nativeOnly = planRuns(sources, getPluginsFromNames(['java']), {results, refresh: false, plugins: ['java']}, results, [tmpDir])
        expect(nativeOnly.map(it => [it.source, it.plugins.map(p => p.name)])).toEqual([[NATIVE_SOURCE, ['java']]])
    })

    it('plans nothing for a native plugin with no files, or an SBOM source no plugin covers', () => {
        const {trivy} = inputs()
        expect(planRuns(classifyInputs([trivy]), getPluginsFromNames(['java']), {results, refresh: false, plugins: ['java']}, results, [tmpDir]))
            .toEqual([])
        const hexOnly = write(path.join(tmpDir, 'plan'), 'hex.cdx.json', sbom(trivyTools, 'hex', ['pkg:hex/plug@1.0.0']))
        expect(planRuns(classifyInputs([hexOnly]), getPluginsFromNames(), {results, refresh: false}, results, [tmpDir])).toEqual([])
        expect(warnings).toEqual([expect.stringContaining('trivy: no sbom-* plugin covers the ecosystems in these SBOMs (hex)')])
    })
})

describe('the project name of an SBOM source', () => {
    const described = (name: string, repo: string, tools = trivyTools) =>
        describeSbom(write(path.join(tmpDir, 'names'), name, sbom(tools, repo, [])))

    it('is the shared repo name, whichever producer wrote the SBOMs', () => {
        expect(defaultProjectName([described('a.cdx.json', 'ruby-mastodon'), described('b.cdx.json', 'ruby-mastodon', syftTools)], '/x'))
            .toBe('ruby-mastodon')
    })

    it('falls back to the input folder name when a source spans several repos', () => {
        expect(defaultProjectName([described('c.cdx.json', 'a'), described('d.cdx.json', 'b')], '/x/sboms')).toBe('sboms')
    })

    it('takes the input folder the SBOMs came from, else the first folder given', () => {
        const trivyDir = path.join(tmpDir, 'in', 'trivy')
        const syftDir = path.join(tmpDir, 'in', 'syft')
        const t = describeSbom(write(trivyDir, 'a.cdx.json', sbom(trivyTools, 'a', [])))
        const s = describeSbom(write(syftDir, 'b.cdx.json', sbom(syftTools, 'b', [])))
        const source = {name: 'trivy', sboms: [t]}
        expect(inputFolderOf(source, [syftDir, trivyDir])).toBe(trivyDir)
        expect(inputFolderOf({name: 'syft', sboms: [s]}, [syftDir, trivyDir])).toBe(syftDir)
        expect(inputFolderOf({name: 'trivy', sboms: [t, s]}, [syftDir, trivyDir])).toBe(syftDir)
        expect(inputFolderOf(source, ['/elsewhere'])).toBe('/elsewhere')
    })
})
