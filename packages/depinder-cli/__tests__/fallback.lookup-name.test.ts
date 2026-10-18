import fs from 'fs'
import os from 'os'
import path from 'path'
import {parseCycloneDxFile} from '../src/plugins/sbom/cyclonedx'
import {fallbackLookupName, logLookupFailure, refetchLookupName} from '../src/fallback/lookup-name'
import {log} from '../src/utils/logging'

// Trivy's go-caddy shape: the purl is lowercased, the component name keeps the module's case.
const trivyGo = {
    metadata: {component: {'bom-ref': 'root', type: 'application', name: '/repo'}},
    components: [
        {'bom-ref': 'app', type: 'application', name: 'go.mod'},
        {
            'bom-ref': 'pkg:golang/github.com/masterminds/sprig/v3@v3.3.0',
            type: 'library', name: 'github.com/Masterminds/sprig/v3', version: 'v3.3.0',
            purl: 'pkg:golang/github.com/masterminds/sprig/v3@v3.3.0',
        },
        {
            'bom-ref': 'pkg:golang/github.com/other/dep@v1.0.0',
            type: 'library', name: 'github.com/other/dep', version: 'v1.0.0',
            purl: 'pkg:golang/github.com/other/dep@v1.0.0',
        },
    ],
    dependencies: [
        {ref: 'root', dependsOn: ['app']},
        {ref: 'app', dependsOn: ['pkg:golang/github.com/masterminds/sprig/v3@v3.3.0', 'pkg:golang/github.com/other/dep@v1.0.0']},
    ],
}

describe('fallbackLookupName', () => {
    let tmpDir: string
    beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-lookup-name-')) })
    afterAll(() => fs.rmSync(tmpDir, {recursive: true, force: true}))

    it('asks the registry with the module case Trivy folded away', () => {
        const file = path.join(tmpDir, 'go.trivy.cdx.json')
        fs.writeFileSync(file, JSON.stringify(trivyGo))
        const deps = Object.values(parseCycloneDxFile(file, 'golang')[0].dependencies)
        const sprig = deps.find(it => it.name.toLowerCase().includes('sprig'))!

        expect(sprig.name).toBe('github.com/masterminds/sprig/v3')
        expect(fallbackLookupName(sprig)).toBe('github.com/Masterminds/sprig/v3')
        expect(fallbackLookupName(deps.find(it => it.name.includes('other'))!)).toBe('github.com/other/dep')
    })

    it('keeps the dependency name without a purl, with a bad purl or with another package', () => {
        expect(fallbackLookupName({name: 'github.com/a/b'})).toBe('github.com/a/b')
        expect(fallbackLookupName({name: 'github.com/a/b', purl: 'not a purl'})).toBe('github.com/a/b')
        expect(fallbackLookupName({name: 'github.com/a/b', purl: 'pkg:golang/github.com/A/c@v1'})).toBe('github.com/a/b')
    })

    it('keeps the name for ecosystems whose purl folds case', () => {
        expect(fallbackLookupName({name: 'Newtonsoft.Json', purl: 'pkg:nuget/newtonsoft.json@13.0.1'})).toBe('Newtonsoft.Json')
        expect(fallbackLookupName({name: 'Django', purl: 'pkg:pypi/django@4.2'})).toBe('Django')
    })

    it('reads the maven spelling from the purl', () => {
        expect(fallbackLookupName({name: 'org.x:lib', purl: 'pkg:maven/org.X/Lib@1.0'})).toBe('org.X:Lib')
    })
})

describe('refetchLookupName', () => {
    it('re-fetches a lowercase golang key under the cached library name', () => {
        expect(refetchLookupName('golang', 'github.com/burntsushi/toml', 'github.com/BurntSushi/toml')).toBe('github.com/BurntSushi/toml')
    })

    it('keeps the key name when the cached name is missing, another package, or case-insensitive', () => {
        expect(refetchLookupName('golang', 'github.com/a/b', undefined)).toBe('github.com/a/b')
        expect(refetchLookupName('golang', 'github.com/a/b', 'github.com/a/c')).toBe('github.com/a/b')
        expect(refetchLookupName('npm', 'react', 'React')).toBe('react')
    })
})

describe('logLookupFailure', () => {
    it('logs the package, its ecosystem and the error with its cause on one line', () => {
        const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as any)
        logLookupFailure('dario.cat/mergo', 'go', new Error('fetch failed', {cause: new Error('ECONNRESET')}))
        expect(error).toHaveBeenCalledWith('Registry lookup failed for go package dario.cat/mergo: fetch failed (ECONNRESET)')
        error.mockRestore()
    })
})
