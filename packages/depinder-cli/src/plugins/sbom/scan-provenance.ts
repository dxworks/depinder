import fs from 'fs'
import path from 'path'
import {PINNED_SCANNER_VERSIONS} from '@depinder/core'
import {SbomDescription} from './describe'
import {localScanOutcome} from './scan-outcomes'
import {preflightScanners} from './scanner-preflight'
import {describeVulnSources, vulnSources} from '../../vuln-sources/selection'

/** What one SBOM file's scan actually produced — the per-file half of the provenance record. */
export interface ScannedFileRecord {
    file: string
    trivy: 'ok' | 'skipped'
    grype: 'ok' | 'skipped'
    findingEntries: number
    packageKeys: number
    /** Who wrote the SBOM, when the run knows (see `describe.ts`); absent for a bare scan. */
    producer?: string
    producerVersion?: string
    repo?: string
}

const scannedFiles = new Map<string, ScannedFileRecord>()

export const PROVENANCE_FILE = 'sbom-scan-provenance.json'

/** Starts a file's record before its scan runs; the scan fills it in place. */
export function recordScannedFile(file: string): ScannedFileRecord {
    const record: ScannedFileRecord = {file, trivy: 'skipped', grype: 'skipped', findingEntries: 0, packageKeys: 0}
    scannedFiles.set(file, record)
    return record
}

/** Forgets every scanned file; part of `clearLocalScanCache`. */
export function clearScannedFiles(): void {
    scannedFiles.clear()
}

/** Copies of recorded scans, optionally limited to the supplied SBOM files. */
export function recordedScans(files?: readonly string[]): ScannedFileRecord[] {
    const records = [...scannedFiles.values()].map(record => ({...record}))
    if (files === undefined) return records
    const wanted = new Set(files.map(file => path.resolve(file)))
    return records.filter(record => wanted.has(path.resolve(record.file)))
}

/**
 * Records how the vulnerability numbers in the CSVs were produced.
 *
 * A count without its matcher and DB build date is untraceable: both scanners auto-update their
 * vulnerability databases, so the same SBOM can legitimately yield different counts a week later.
 * One file per run, not a column per row.
 */
export async function writeScanProvenance(
    resultFolder: string, hasGithubToken: boolean, sboms?: SbomDescription[],
    fallback?: {reason: string},
): Promise<string> {
    const preflight = await preflightScanners()
    // One provenance file per source subfolder: only that source's files, in scan order, each
    // stamped with the tool that wrote the SBOM. Without descriptions every scanned file is listed.
    const sbomFiles: ScannedFileRecord[] = sboms
        ? [...scannedFiles.entries()].flatMap(([file, record]) => {
            const sbom = sboms.find(it => it.file === path.resolve(file))
            return sbom ? [{...record, producer: sbom.producer, producerVersion: sbom.toolVersion, repo: sbom.repo}] : []
        })
        : [...scannedFiles.values()]
    const selection = vulnSources()
    const {githubAdvisoryFallback, vulnerabilityAnalysis} = localScanOutcome(sbomFiles, selection, hasGithubToken)
    const provenance = {
        generatedAt: new Date().toISOString(),
        ...(sboms?.length ? {source: sboms[0].producer} : {}),
        // Only when a vulnerability server was asked and failed: the local scan stood in for it.
        ...(fallback ? {vulnerabilitySource: 'local', fallbackReason: fallback.reason} : {}),
        pinnedVersions: PINNED_SCANNER_VERSIONS,
        scanners: {
            trivy: preflight.trivy,
            grype: preflight.grype,
        },
        selectedSources: describeVulnSources(selection).split(', '),
        githubAdvisoryFallback,
        vulnerabilityAnalysis,
        sbomFiles,
    }
    const file = path.resolve(resultFolder, PROVENANCE_FILE)
    fs.writeFileSync(file, JSON.stringify(provenance, null, 2))
    return file
}
