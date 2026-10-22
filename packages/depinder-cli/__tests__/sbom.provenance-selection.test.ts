import fs from 'fs'
import os from 'os'
import path from 'path'
import {PINNED_SCANNER_VERSIONS} from '@depinder/core'
import {
    clearScannedFiles,
    PROVENANCE_FILE,
    recordScannedFile,
    ScannedFileRecord,
    writeScanProvenance,
} from '../src/plugins/sbom/scan-provenance'
import {resetScannerPreflight} from '../src/plugins/sbom/scanner-preflight'
import {SbomDescription} from '../src/plugins/sbom/describe'
import {parseVulnSources, resetVulnSources, setVulnSources} from '../src/vuln-sources/selection'
import {writeServerProvenance} from '../src/vuln-sources/run'
import {VulnServerAnswer} from '../src/vuln-sources/server'
import type {ScannerProcessControl} from './helpers/scanner-process'

/**
 * The per-source provenance file is judged against the SELECTED sources: these integration tests
 * prove selection, token and source filtering reach the classifier and that per-file metadata
 * survives. The verdict matrix is pure-tested in sbom.scan-outcomes.test.ts.
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

type ScanStatus = 'ok' | 'skipped'

let tmp: string
let fileA: string
let fileB: string

function recorded(file: string, statuses: {trivy?: ScanStatus, grype?: ScanStatus}, findingEntries = 0): ScannedFileRecord {
    const record = recordScannedFile(file)
    if (statuses.trivy) record.trivy = statuses.trivy
    if (statuses.grype) record.grype = statuses.grype
    record.findingEntries = findingEntries
    return record
}

function sbomDescriptionOf(file: string, producer = 'syft'): SbomDescription {
    return {
        file: path.resolve(file), producer, toolVersion: '2.5.0', repo: 'example-repository',
        repoFromMetadata: true, purlTypes: new Set(['npm']),
    }
}

async function provenance(hasGithubToken = false, sboms?: SbomDescription[]): Promise<any> {
    await writeScanProvenance(tmp, hasGithubToken, sboms)
    return JSON.parse(fs.readFileSync(path.join(tmp, PROVENANCE_FILE), 'utf8'))
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-provenance-'))
    fileA = path.join(tmp, 'a.cdx.json')
    fileB = path.join(tmp, 'b.cdx.json')
    fs.writeFileSync(fileA, '{}')
    fs.writeFileSync(fileB, '{}')
    control.installed.trivy = true
    control.installed.grype = true
    control.scanDefault.trivy = 'ok'
    control.scanDefault.grype = 'ok'
    control.scanFiles = {}
    vi.stubEnv('TRIVY_BIN', 'trivy')
    vi.stubEnv('GRYPE_BIN', 'grype')
    resetScannerPreflight()
    clearScannedFiles()
    resetVulnSources()
})

afterEach(() => {
    resetVulnSources()
    resetScannerPreflight()
    clearScannedFiles()
    vi.unstubAllEnvs()
    fs.rmSync(tmp, {recursive: true, force: true})
})

describe('writeScanProvenance', () => {
    it('filters to the described source before classifying, and keeps the file metadata', async () => {
        control.installed.grype = false
        setVulnSources(parseVulnSources('trivy,github'))
        recorded(fileA, {trivy: 'ok'})
        recorded(fileB, {}) // a second source's failed scan must not leak into this verdict

        const saved = await provenance(false, [sbomDescriptionOf(fileA)])

        expect(saved.selectedSources).toEqual(['trivy', 'github'])
        expect(saved.githubAdvisoryFallback).toBe(false)
        expect(saved.vulnerabilityAnalysis).toBe('complete')
        expect(saved.source).toBe('syft')
        expect(saved.pinnedVersions).toEqual(PINNED_SCANNER_VERSIONS)
        expect(saved.scanners.trivy).toMatchObject({
            installed: true,
            version: '0.74.0',
            pinnedVersion: PINNED_SCANNER_VERSIONS.trivy,
            versionMatchesPin: true,
            dbVersion: '2',
            dbBuiltAt: '2026-10-01T00:00:00Z',
        })
        expect(saved.scanners.grype.installed).toBe(false)
        expect(saved.sbomFiles).toEqual([{
            file: path.resolve(fileA),
            trivy: 'ok',
            grype: 'skipped',
            findingEntries: 0,
            packageKeys: 0,
            producer: 'syft',
            producerVersion: '2.5.0',
            repo: 'example-repository',
        }])
    })

    it('marks the GitHub-token fallback when the selected scan produced nothing, despite installed binaries', async () => {
        setVulnSources(parseVulnSources('trivy'))
        recorded(fileA, {})

        const saved = await provenance(true)

        expect(saved.selectedSources).toEqual(['trivy'])
        expect(saved.githubAdvisoryFallback).toBe(true)
        expect(saved.vulnerabilityAnalysis).toBe('github-advisories-only')
        expect(saved.sbomFiles).toEqual([{
            file: path.resolve(fileA),
            trivy: 'skipped',
            grype: 'skipped',
            findingEntries: 0,
            packageKeys: 0,
        }])
    })
})

describe('writeServerProvenance', () => {
    it('stamps the selected sources on a server-produced record', () => {
        setVulnSources(parseVulnSources('all'))
        const answer: VulnServerAnswer = {
            vulnerabilities: new Map(),
            unsupported: new Map(),
            databases: {trivy: [], grype: []},
            scanners: {trivy: [], grype: []},
            purls: 0,
            requests: 0,
            serverTiming: {},
        }

        writeServerProvenance(tmp, {source: 'server', server: 'http://test', answer, files: []})

        const saved = JSON.parse(fs.readFileSync(path.join(tmp, PROVENANCE_FILE), 'utf8'))
        expect(saved.selectedSources).toEqual(['trivy', 'grype', 'github'])
        expect(saved.vulnerabilityAnalysis).toBe('complete')
        expect(saved.vulnerabilitySource).toBe('server')
        expect(saved.vulnerabilityServer).toBe('http://test')
    })
})
