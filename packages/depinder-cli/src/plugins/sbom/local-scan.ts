import {execFile} from 'child_process'
import fs from 'fs'
import path from 'path'
import {promisify} from 'util'
import {buildVulnerabilityIndex, type GrypeReport, type TrivyReport, type Vulnerability} from '@depinder/core'
import {vulnSources} from '../../vuln-sources/selection'
import {log} from '../../utils/logging'
import {timePhase} from '../../utils/profile'
import {sbomPackageKeyer} from './package-keys'
import {clearScannedFiles, recordScannedFile} from './scan-provenance'
import {
    MAX_SCANNER_OUTPUT_BYTES,
    preflightScanners,
    resetScannerPreflight,
    scannerFailureReason,
    warmScannerDatabases,
} from './scanner-preflight'

/**
 * Local vulnerability scanning of SBOM files with Trivy and Grype.
 *
 * Client machines ship us CycloneDX SBOMs; the vulnerability databases live only on OUR machine.
 * Both scanners accept an SBOM file directly (`trivy sbom --format json <file>` and
 * `grype sbom:<file> -o json`), so no GitHub token or per-package advisory API is involved.
 *
 * The two reports are merged by core's `buildVulnerabilityIndex`, the same merge the vuln server
 * runs, with findings tied to packages by `package-keys.ts`.
 *
 * A scan runs ONCE per SBOM file per process (many projects and all six sbom-* plugins share one
 * file), and a missing or failing binary degrades to a warning: the analysis still completes, just
 * without that tool's findings. Which binaries exist is settled up front by `scanner-preflight.ts`;
 * what each scan produced is recorded by `scan-provenance.ts`.
 */

const execFileAsync = promisify(execFile)

async function runScanner(tool: string, bin: string, args: string[], sbomFile: string): Promise<string | undefined> {
    const started = Date.now()
    try {
        const {stdout} = await timePhase(`scan:${tool}`, () =>
            execFileAsync(bin, args, {maxBuffer: MAX_SCANNER_OUTPUT_BYTES}))
        log.info(`${tool} scan of ${path.basename(sbomFile)} done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
        return stdout
    } catch (e: any) {
        const reason = e?.code === 'ENOENT'
            ? `binary '${bin}' not found (set ${tool.toUpperCase()}_BIN or add it to PATH)`
            : scannerFailureReason(e)
        log.warn(`${tool} scan of ${path.basename(sbomFile)} skipped: ${reason}`)
        return undefined
    }
}

function parseReport<T>(tool: string, json: string | undefined): T | undefined {
    if (json === undefined) return undefined
    try {
        return JSON.parse(json) as T
    } catch (e: any) {
        log.warn(`${tool} produced unparseable JSON: ${e?.message ?? e}`)
        return undefined
    }
}

/**
 * The result model. `available` means AT LEAST ONE SCANNER ACTUALLY PRODUCED A REPORT — the sbom
 * parser turns it into `project.exactVersionVulnerabilities`, which suppresses the GHSA fallback
 * and takes each dependency's findings verbatim. It must never be true when nothing ran.
 */
export interface LocalScanResult {
    available: boolean
    index: Map<string, Vulnerability[]>
}

async function scanFile(sbomFile: string): Promise<LocalScanResult> {
    if (!fs.existsSync(sbomFile)) {
        log.warn(`Local vulnerability scan skipped: ${sbomFile} does not exist`)
        return {available: false, index: new Map()}
    }

    // Registered before the scanners run, so the provenance record lists files in the order they
    // were asked for — the same order whether the files are scanned one after another or at once.
    const record = recordScannedFile(sbomFile)

    // Preflight already established which binaries exist; do not re-discover it per file.
    const preflight = await preflightScanners()

    // The two scanners are independent — run them in parallel. A scanner the run did not select
    // (`--vuln-source`) is not started at all, so `github` alone costs no subprocess.
    const selected = vulnSources()

    // One database refresh for the whole run, awaited by every file — see warmScannerDatabases.
    await warmScannerDatabases()

    const [trivyJson, grypeJson] = await Promise.all([
        selected.trivy && preflight.trivy.installed
            ? runScanner('trivy', preflight.trivy.bin, ['sbom', '--format', 'json', sbomFile], sbomFile)
            : Promise.resolve(undefined),
        selected.grype && preflight.grype.installed
            ? runScanner('grype', preflight.grype.bin, [`sbom:${sbomFile}`, '-o', 'json'], sbomFile)
            : Promise.resolve(undefined),
    ])

    const trivy = parseReport<TrivyReport>('trivy', trivyJson)
    const grype = parseReport<GrypeReport>('grype', grypeJson)

    record.trivy = trivy ? 'ok' : 'skipped'
    record.grype = grype ? 'ok' : 'skipped'

    if (!trivy && !grype) {
        if (selected.trivy || selected.grype) {
            log.warn(`No local vulnerability scanner available for ${path.basename(sbomFile)}`)
        }
        return {available: false, index: new Map()}
    }

    const {index} = buildVulnerabilityIndex(trivy, grype, sbomPackageKeyer)
    let findings = 0
    for (const list of index.values()) findings += list.length
    record.findingEntries = findings
    record.packageKeys = index.size
    log.info(`Local scan of ${path.basename(sbomFile)}: ${findings} finding entries across ${index.size} package keys`
        + ` (trivy: ${record.trivy}, grype: ${record.grype})`)
    return {available: true, index}
}

/** One scan per SBOM file per process — 67 projects and six sbom plugins share each file. */
const scanCache = new Map<string, Promise<LocalScanResult>>()

export function scanSbomFileOnce(sbomFile: string): Promise<LocalScanResult> {
    const key = path.resolve(sbomFile)
    let pending = scanCache.get(key)
    if (!pending) {
        pending = scanFile(key)
        scanCache.set(key, pending)
    }
    return pending
}

/** Exposed for tests. Clears every process-global piece of scan state, including the preflight. */
export function clearLocalScanCache(): void {
    scanCache.clear()
    clearScannedFiles()
    resetScannerPreflight()
}
