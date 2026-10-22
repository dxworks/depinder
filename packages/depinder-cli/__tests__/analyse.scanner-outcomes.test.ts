import type {MockInstance} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {createAnalyseCommand} from '../src/commands/analyse'
import {resetSharedCacheDb, sharedCacheDb} from '../src/cache/sqlite-cache'
import {clearSbomCache, deferSbomFindings} from '../src/plugins/sbom'
import {clearLocalScanCache} from '../src/plugins/sbom/local-scan'
import {PROVENANCE_FILE} from '../src/plugins/sbom/scan-provenance'
import {clearSbomDescriptions} from '../src/plugins/sbom/describe'
import {resetBulkResolve} from '../src/resolver/bulk-memory'
import {resetProfile} from '../src/utils/profile'
import {resetVulnSources} from '../src/vuln-sources/selection'
import {log} from '../src/utils/logging'
import type {ScannerProcessControl} from './helpers/scanner-process'

/**
 * The final 'Vulnerability data source' line must describe what the selected scanners produced
 * on this run's files, not which binaries answered --version. CLI runs drive the real scan path
 * against the shared scanner-process fake, per the hoisted control modes.
 */

const control = vi.hoisted((): ScannerProcessControl => ({
    installed: {trivy: true, grype: true},
    scanDefault: {trivy: 'fail', grype: 'fail'},
    // Per input file basename -> per tool mode, overriding the tool default.
    scanFiles: {},
}))

vi.mock('child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('child_process')>()
    const {stubScannerExecFile} = await import('./helpers/scanner-process')
    return {...actual, execFile: stubScannerExecFile(control)}
})

/** One flat CycloneDX BOM: a root application named example-repository with one library child. */
function bom(producer: string): object {
    return {
        bomFormat: 'CycloneDX',
        specVersion: '1.5',
        version: 1,
        metadata: {
            tools: {components: [{name: producer, version: '1.0.0'}]},
            component: {'bom-ref': 'root-app', type: 'application', name: 'example-repository', version: '1.0.0'},
        },
        components: [
            {'bom-ref': 'lib:example', type: 'library', name: 'example-library', version: '1.0.0', purl: 'pkg:npm/example-library@1.0.0'},
        ],
        dependencies: [{ref: 'root-app', dependsOn: ['lib:example']}],
    }
}

describe('the final vulnerability summary reports actual scan outcomes', () => {
    let tmp: string
    let inputDir: string
    let resultsDir: string
    let messages: {level: string, text: string}[]
    let spies: MockInstance[]

    const writeInput = (name: string, producer: string): string => {
        fs.mkdirSync(inputDir, {recursive: true})
        const file = path.join(inputDir, name)
        fs.writeFileSync(file, JSON.stringify(bom(producer)))
        return file
    }
    const provenance = (source: string) =>
        JSON.parse(fs.readFileSync(path.join(resultsDir, source, PROVENANCE_FILE), 'utf8'))
    const analyse = (vulnSource: string) =>
        createAnalyseCommand().parseAsync([inputDir, '-r', resultsDir, '--no-resolver', '--vuln-source', vulnSource], {from: 'user'})
    const texts = () => messages.map(it => it.text)
    const lastLine = () => messages[messages.length - 1]

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-scanout-'))
        inputDir = path.join(tmp, 'in')
        resultsDir = path.join(tmp, 'results')
        control.installed.trivy = true
        control.installed.grype = true
        control.scanDefault.trivy = 'fail'
        control.scanDefault.grype = 'fail'
        control.scanFiles = {}

        vi.stubEnv('DEPINDER_CACHE_DB', path.join(tmp, 'cache', 'depinder.sqlite'))
        vi.stubEnv('TRIVY_BIN', 'trivy')
        vi.stubEnv('GRYPE_BIN', 'grype')
        vi.stubEnv('GH_TOKEN', '')
        resetSharedCacheDb()
        resetBulkResolve()
        clearSbomCache()
        clearLocalScanCache()
        clearSbomDescriptions()
        resetProfile()
        resetVulnSources()
        sharedCacheDb().setLib('npm:example-library', {name: 'example-library', licenses: [], versions: []})

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

    // The metadata footer must still come after the summary line; asserted once, on the success
    // path where both are guaranteed to be printed. Ordering beyond that is analyse.final-summary.
    const expectFinalOrdering = () => {
        const footerAt = texts().indexOf('Final metadata summary:')
        const summaryAt = texts().findIndex(text => text.startsWith('Vulnerability data source:'))
        expect(footerAt).toBeGreaterThan(summaryAt)
        expect(lastLine()).toEqual({level: 'info', text: 'Done'})
    }

    it('installed Trivy whose scan throws ends NONE, not a version claim', async () => {
        writeInput('app-trivy.cdx.json', 'trivy')

        await analyse('trivy')

        expect(provenance('trivy').vulnerabilityAnalysis).toBe('disabled')
        expect(messages).toContainEqual({
            level: 'warn',
            text: 'Vulnerability data source: NONE - no selected local scanner produced a report',
        })
        expect(texts()).not.toContain('Vulnerability data source: trivy 0.74.0')
    })

    it('one scanned and one failed file for the same tool is PARTIAL, per-source provenance split', async () => {
        writeInput('app-trivy.cdx.json', 'trivy')
        writeInput('app-syft.cdx.json', 'syft')
        control.scanFiles = {
            'app-trivy.cdx.json': {trivy: 'ok'},
            'app-syft.cdx.json': {trivy: 'fail'},
        }

        await analyse('trivy')

        expect(provenance('trivy').vulnerabilityAnalysis).toBe('complete')
        expect(provenance('syft').vulnerabilityAnalysis).toBe('disabled')
        expect(messages).toContainEqual({
            level: 'warn',
            text: 'Vulnerability data source: trivy 0.74.0 - PARTIAL, trivy did not complete every SBOM',
        })
    })

    it('zero-finding reports for every file stay an info success', async () => {
        writeInput('app-trivy.cdx.json', 'trivy')
        control.scanDefault.trivy = 'ok'
        control.installed.grype = false

        await analyse('trivy')

        expect(provenance('trivy').vulnerabilityAnalysis).toBe('complete')
        expect(messages).toContainEqual({level: 'info', text: 'Vulnerability data source: trivy 0.74.0'})
        expect(texts().filter(text => text.startsWith('Vulnerability data source:'))).toHaveLength(1)
        expectFinalOrdering()
    })
})
