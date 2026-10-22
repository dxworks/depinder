import type {MockInstance} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {createAnalyseCommand} from '../src/commands/analyse'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {missCache} from '../src/cache/misses'
import {clearSbomCache, deferSbomFindings} from '../src/plugins/sbom'
import {clearLocalScanCache} from '../src/plugins/sbom/local-scan'
import {clearSbomDescriptions} from '../src/plugins/sbom/describe'
import {resetBulkResolve} from '../src/resolver/bulk-memory'
import {resetProfile} from '../src/utils/profile'
import {resetVulnSources} from '../src/vuln-sources/selection'
import {log} from '../src/utils/logging'

/**
 * One flat CycloneDX BOM: a root application component in metadata, its direct dependencies as
 * library components - a single project per file either way. `producer` is the tool the BOM
 * credits, which is what sorts the file into the trivy/ or syft/ results folder.
 */
function bom(producer: string, libraries: {ref: string, name: string}[]): object {
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: {
            tools: {components: [{name: producer, version: '1.0.0'}]},
            component: {'bom-ref': 'root-app', type: 'application', name: 'example-repository', version: '1.0.0'},
        },
        components: libraries.map(lib => ({
            'bom-ref': lib.ref,
            type: 'library',
            name: lib.name,
            version: '1.0.0',
            purl: `pkg:npm/${lib.name}@1.0.0`,
        })),
        dependencies: [{ref: 'root-app', dependsOn: libraries.map(lib => lib.ref)}],
    }
}

describe('the final metadata summary in the CLI output', () => {
    let tmp: string
    let inputDir: string
    let resultsDir: string
    let messages: {level: string, text: string}[]
    let spies: MockInstance[]

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-final-'))
        inputDir = path.join(tmp, 'in')
        resultsDir = path.join(tmp, 'results')
        fs.mkdirSync(inputDir, {recursive: true})
        fs.writeFileSync(path.join(inputDir, 'app-trivy.cdx.json'), JSON.stringify(bom('trivy', [
            {ref: 'lib:cached', name: 'cached-lib'},
            {ref: 'lib:miss', name: 'missing-lib'},
        ])))
        fs.writeFileSync(path.join(inputDir, 'app-syft.cdx.json'), JSON.stringify(bom('syft', [
            {ref: 'lib:cached', name: 'cached-lib'},
        ])))

        vi.stubEnv('DEPINDER_CACHE_DB', path.join(tmp, 'cache', 'depinder.sqlite'))
        // Unmanaged tools point at paths that do not exist: the preflight reports ENOENT and no
        // scanner subprocess or database download ever runs.
        vi.stubEnv('TRIVY_BIN', path.join(tmp, 'no-such-trivy'))
        vi.stubEnv('GRYPE_BIN', path.join(tmp, 'no-such-grype'))
        resetSharedCacheDb()
        resetBulkResolve()
        clearSbomCache()
        clearLocalScanCache()
        clearSbomDescriptions()
        resetProfile()
        resetVulnSources()

        sharedCacheDb().setLib('npm:cached-lib', {name: 'cached-lib', licenses: [], versions: []})
        missCache.set('npm:missing-lib')

        messages = []
        spies = (['info', 'warn', 'error'] as const).map(level =>
            vi.spyOn(log, level).mockImplementation(((text: string) => {
                messages.push({level, text})
                return log
            }) as any))
    })

    afterEach(() => {
        for (const spy of spies) spy.mockRestore()
        deferSbomFindings(false)
        resetVulnSources()
        resetSharedCacheDb()
        resetBulkResolve()
        clearSbomCache()
        clearLocalScanCache()
        clearSbomDescriptions()
        resetProfile()
        vi.unstubAllEnvs()
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    it('prints every source\'s saved metadata counts once, after the reports and the profile, before Done', async () => {
        await createAnalyseCommand().parseAsync(
            [inputDir, '-r', resultsDir, '--no-resolver', '--vuln-source', 'trivy', '--profile'],
            {from: 'user'},
        )

        const trivyFolder = path.join(resultsDir, 'trivy')
        const syftFolder = path.join(resultsDir, 'syft')
        const texts = messages.map(it => it.text)

        // The saved artifacts, read back: the footer may only repeat what was written.
        expect(JSON.parse(fs.readFileSync(path.join(trivyFolder, 'summary.json'), 'utf8')).totals)
            .toEqual({detected: 2, resolved: 1, unresolved: 1, skipped: 0})
        expect(JSON.parse(fs.readFileSync(path.join(syftFolder, 'summary.json'), 'utf8')).totals)
            .toEqual({detected: 1, resolved: 1, unresolved: 0, skipped: 0})

        const footerAt = texts.indexOf('Final metadata summary:')
        expect(footerAt).toBeGreaterThan(-1)
        const resultsAt = texts.map((text, i) => /Results for .+ are written/.test(text) ? i : -1).filter(i => i >= 0)
        expect(resultsAt.length).toBe(2)
        expect(Math.max(...resultsAt)).toBeLessThan(footerAt)
        const profileAt = texts.map((text, i) => text.startsWith('Profile:') ? i : -1).filter(i => i >= 0)
        expect(profileAt.length).toBeGreaterThan(0)
        expect(Math.max(...profileAt)).toBeLessThan(footerAt)

        const trivyLine = 'Metadata completeness (trivy): 2 detected, 1 resolved, 1 unresolved, 0 skipped (unique ecosystem/name/version)'
        const syftLine = 'Metadata completeness (syft): 1 detected, 1 resolved, 0 unresolved, 0 skipped (unique ecosystem/name/version)'
        const trivyAt = texts.indexOf(trivyLine)
        const syftAt = texts.indexOf(syftLine)
        expect(trivyAt).toBeGreaterThan(footerAt)
        expect(syftAt).toBeGreaterThan(footerAt)
        expect(texts.lastIndexOf(trivyLine)).toBe(trivyAt)
        expect(texts.lastIndexOf(syftLine)).toBe(syftAt)
        expect(messages[trivyAt].level).toBe('warn')
        expect(messages[syftAt].level).toBe('info')

        const unresolvedCsv = path.join(trivyFolder, 'unresolved-packages.csv')
        const detailLines = messages.filter(it => it.text.startsWith('  Check unresolved packages:'))
        expect(detailLines).toEqual([{level: 'warn', text: `  Check unresolved packages: ${unresolvedCsv}`}])
        expect(fs.existsSync(unresolvedCsv)).toBe(true)
        expect(texts).toContain(`  Summary: ${path.join(trivyFolder, 'summary.json')}`)
        expect(texts).toContain(`  Summary: ${path.join(syftFolder, 'summary.json')}`)

        expect(messages[messages.length - 1]).toEqual({level: 'info', text: 'Done'})
        expect(texts.slice(footerAt).some(text => text.startsWith('Profile:'))).toBe(false)
    })
})
