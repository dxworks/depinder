import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {type Canary, CANARIES} from './canaries.js'
import type {VulnConfig} from './config.js'
import type {GrypeReport, TrivyReport} from './merge/index.js'
import {parseVulnRequest} from './request.js'
import {buildSbom} from './sbom.js'
import {SCAN_DIR_PREFIX, scanGrype, ScanError, type ScannerName, scanTrivy} from './scanners.js'

/**
 * The smoke test a freshly downloaded build must pass before it goes live.
 *
 * The canaries (`canaries.ts`) are scanned against the new build with that tool's exact Phase 1
 * scan command, through the same `buildSbom` and the same scanner wrapper as a request. To pass:
 *   (a) the scanner exits 0 and its output parses;
 *   (b) every canary's `must` id is found;
 *   (c) the total findings on the canaries are at least 90 % of what the current build gave.
 * (c) is what catches a truncated or half-imported database: it can still contain Log4Shell while
 * missing thousands of advisories, and a sudden drop on a fixed set is the signal. It costs one
 * extra second. That the build is newer than the current one is the updater's check, not this.
 */

/** The share of the current build's canary findings a new build must reach. */
const MIN_FINDINGS_RATIO = 0.9

export class SmokeError extends Error {}

interface SmokeCount {
    /** Every finding on every canary. */
    findings: number
    /** The canaries whose `must` id was not found. */
    missing: Canary[]
}

/** Counts Trivy's findings and the `must` ids found, by bom-ref `c<i>` = `canaries[i]`. */
export function countTrivy(report: TrivyReport, canaries: readonly Canary[] = CANARIES): SmokeCount {
    const found = new Set<string>()
    let findings = 0
    for (const result of report.Results ?? []) {
        for (const v of result.Vulnerabilities ?? []) {
            findings++
            const ref = v.PkgIdentifier?.BOMRef
            for (const id of [v.VulnerabilityID, ...v.VendorIDs ?? []]) if (ref && id) found.add(`${ref}|${id}`)
        }
    }
    return {findings, missing: canaries.filter((c, i) => !found.has(`c${i}|${c.must}`))}
}

/** The same for Grype: a `must` id may be the match's own or one of its related ids. */
export function countGrype(report: GrypeReport, canaries: readonly Canary[] = CANARIES): SmokeCount {
    const found = new Set<string>()
    let findings = 0
    for (const m of report.matches ?? []) {
        findings++
        const ref = m.artifact?.id
        for (const id of [m.vulnerability?.id, ...(m.relatedVulnerabilities ?? []).map(r => r.id)]) {
            if (ref && id) found.add(`${ref}|${id}`)
        }
    }
    return {findings, missing: canaries.filter((c, i) => !found.has(`c${i}|${c.must}`))}
}

/** (b) and (c). Throws `SmokeError` with the reason; `baseline` null skips (c). */
export function judgeSmoke(tool: ScannerName, count: SmokeCount, baseline: number | null): void {
    if (count.missing.length > 0) {
        const shown = count.missing.slice(0, 3).map(c => `${c.must} on ${c.purl}`).join(', ')
        throw new SmokeError(`smoke test: ${tool} missed ${count.missing.length} canary id(s): ${shown}`)
    }
    if (baseline !== null && count.findings < MIN_FINDINGS_RATIO * baseline) {
        throw new SmokeError(`smoke test: ${tool} found ${count.findings} on the canaries, the current build ${baseline}; `
            + `below ${MIN_FINDINGS_RATIO * 100} %`)
    }
}

/**
 * Scans the canaries against the build in `dir` and judges the result. Returns the findings, which
 * become the build's `canary_findings`, the next build's baseline.
 */
export async function smokeTest(
    tool: ScannerName,
    dir: string,
    config: Pick<VulnConfig, 'trivyBin' | 'grypeBin' | 'scanTimeoutMs' | 'tmpDir'>,
    baseline: number | null,
    signal?: AbortSignal,
    canaries: readonly Canary[] = CANARIES,
): Promise<number> {
    const {scan} = parseVulnRequest({purls: canaries.map(c => c.purl)}, canaries.length)
    if (scan.length !== canaries.length) throw new SmokeError('smoke test: a canary is not a scannable purl')

    // A request's folder prefix, so a crash's leftover is swept like a request's.
    const tmp = await mkdtemp(join(config.tmpDir, SCAN_DIR_PREFIX))
    let count: SmokeCount
    try {
        const sbomPath = join(tmp, 'sbom.json')
        await writeFile(sbomPath, buildSbom(scan))
        count = tool === 'trivy'
            ? countTrivy(await scanTrivy(sbomPath, dir, config, signal), canaries)
            : countGrype(await scanGrype(sbomPath, dir, config, signal), canaries)
    } catch (e) {
        if (e instanceof ScanError) throw new SmokeError(`smoke test: ${tool} ${e.reason}`)
        throw e
    } finally {
        await rm(tmp, {recursive: true, force: true})
    }
    judgeSmoke(tool, count, baseline)
    return count.findings
}
