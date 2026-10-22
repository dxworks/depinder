import fs from 'fs'
import os from 'os'
import path from 'path'
import {clearLocalScanCache, scanSbomFileOnce} from '../src/plugins/sbom/local-scan'
import {recordedScans} from '../src/plugins/sbom/scan-provenance'
import {parseVulnSources, resetVulnSources, setVulnSources} from '../src/vuln-sources/selection'
import type {ScannerProcessControl} from './helpers/scanner-process'

/**
 * A selected scan that throws or prints non-JSON must end as a skipped record, not an error.
 * One scanSbomFileOnce call below the CLI; no resolver/cache/command setup.
 */

const control = vi.hoisted((): ScannerProcessControl => ({
    installed: {trivy: true, grype: true},
    scanDefault: {trivy: 'ok', grype: 'ok'},
    scanFiles: {},
}))

vi.mock('child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('child_process')>()
    const {stubScannerExecFile} = await import('./helpers/scanner-process')
    return {...actual, execFile: stubScannerExecFile(control)}
})

describe('scanSbomFileOnce degrades a failed selected scan to a skipped record', () => {
    let tmp: string
    let file: string

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-localscan-'))
        file = path.join(tmp, 'app.cdx.json')
        fs.writeFileSync(file, '{}')
        control.installed.trivy = true
        control.installed.grype = true
        control.scanDefault.trivy = 'ok'
        control.scanDefault.grype = 'ok'
        control.scanFiles = {}
        vi.stubEnv('TRIVY_BIN', 'trivy')
        vi.stubEnv('GRYPE_BIN', 'grype')
        clearLocalScanCache()
        resetVulnSources()
        setVulnSources(parseVulnSources('trivy'))
    })

    afterEach(() => {
        clearLocalScanCache()
        resetVulnSources()
        vi.unstubAllEnvs()
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    it.each([
        {mode: 'fail' as const, because: 'the scan process throws'},
        {mode: 'bad' as const, because: 'the scan prints unparseable JSON'},
    ])('when $because: trivy reports nothing and the file records both scanners skipped', async ({mode}) => {
        control.scanDefault.trivy = mode

        const result = await scanSbomFileOnce(file)

        expect(result.available).toBe(false)
        expect(result.index.size).toBe(0)
        const [saved] = recordedScans([file])
        expect(saved.trivy).toBe('skipped')
        expect(saved.grype).toBe('skipped')
    })
})
