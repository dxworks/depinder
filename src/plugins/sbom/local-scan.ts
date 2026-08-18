import {execFile} from 'child_process'
import fs from 'fs'
import path from 'path'
import {promisify} from 'util'
import {Vulnerability} from '../../extension-points/vulnerability-checker'
import {parsePurl} from './cyclonedx'
import {log} from '../../utils/logging'

/**
 * Local vulnerability scanning of SBOM files with Trivy and Grype.
 *
 * Client machines ship us CycloneDX SBOMs; the vulnerability databases live only on OUR machine.
 * Both scanners accept an SBOM file directly (`trivy sbom --format json <file>` and
 * `grype sbom:<file> -o json`), so no GitHub token or per-package advisory API is involved.
 *
 * Findings from both tools are unioned and deduplicated by (normalized package key, canonical
 * vulnerability id). Where both tools report the same finding, fields merge by strength (measured
 * on the Zeppelin SBOMs): Grype knows the vulnerable range and CVSS score more often, Trivy knows
 * the published timestamp; references and identifiers are unioned.
 *
 * A scan runs ONCE per SBOM file per process (many projects and all six sbom-* plugins share one
 * file), and a missing or failing binary degrades to a warning: the analysis still completes, just
 * without that tool's findings.
 */

const execFileAsync = promisify(execFile)

/** Scanner JSON can be tens of MB (Grype on Zeppelin: ~3,700 matches). */
const MAX_SCANNER_OUTPUT_BYTES = 1024 * 1024 * 1024

// ---------------------------------------------------------------------------
// Scanner output models — only the fields we read.
// ---------------------------------------------------------------------------

export interface TrivyReport {
    Results?: {
        Vulnerabilities?: {
            VulnerabilityID?: string
            /** Aliases from the advisory source, e.g. the GHSA id when the CVE is primary. */
            VendorIDs?: string[]
            PkgName?: string
            InstalledVersion?: string
            PkgIdentifier?: { PURL?: string }
            FixedVersion?: string
            Severity?: string
            Title?: string
            Description?: string
            PrimaryURL?: string
            References?: string[]
            PublishedDate?: string
            CVSS?: { [source: string]: { V3Score?: number, V2Score?: number } }
        }[]
    }[]
}

export interface GrypeReport {
    matches?: {
        vulnerability?: {
            id?: string
            severity?: string
            description?: string
            dataSource?: string
            urls?: string[]
            cvss?: { version?: string, metrics?: { baseScore?: number } }[]
            fix?: { versions?: string[] }
        }
        relatedVulnerabilities?: {
            id?: string
            description?: string
            dataSource?: string
            urls?: string[]
        }[]
        matchDetails?: { found?: { versionConstraint?: string } }[]
        artifact?: { name?: string, version?: string, purl?: string }
    }[]
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/**
 * All the keys under which one scanned package is findable, plus the canonical key used to
 * deduplicate findings across tools. Both tools echo the SBOM's purl, so after normalization the
 * two tools' findings for the same package land on the same keys:
 *  - the purl stripped of qualifiers/subpath (Syft purls carry a `package-id` qualifier)
 *  - `name@version` with the name in depinder's registrar form (maven `groupId:artifactId`,
 *    npm `@scope/name`) — this equals DepinderDependency.id, the key the sbom parser looks up.
 *  - the tool's own name@version, for robustness (Grype's artifact.name is the BARE maven
 *    artifactId, so this key differs per tool and must never be the dedup key when a purl parses).
 */
export function packageKeys(purl: string | undefined, name?: string, version?: string): {keys: string[], dedupKey?: string} {
    const keys: string[] = []
    let dedupKey: string | undefined
    if (purl) {
        keys.push(purl.split('?')[0].split('#')[0])
        const parsed = parsePurl(purl)
        if (parsed) {
            dedupKey = `${parsed.name}@${parsed.version}`
            keys.push(dedupKey)
        }
    }
    if (name && version) {
        const key = `${name}@${version}`
        if (!keys.includes(key)) keys.push(key)
        dedupKey = dedupKey ?? key
    }
    dedupKey = dedupKey ?? keys[0]
    return {keys, dedupKey}
}

/** CVE id if one is known, else the first id (typically a GHSA) — the cross-tool dedup handle. */
function canonicalId(ids: string[]): string | undefined {
    return ids.find(id => id.toUpperCase().startsWith('CVE-')) ?? ids[0]
}

function identifierType(id: string): string {
    const upper = id.toUpperCase()
    if (upper.startsWith('CVE-')) return 'CVE'
    if (upper.startsWith('GHSA-')) return 'GHSA'
    return 'OTHER'
}

/** One tool's view of one finding, before cross-tool merging. */
interface RawFinding {
    packageKeys: string[]
    /** The purl-derived name@version — identical for both tools, the cross-tool dedup handle. */
    packageDedupKey?: string
    ids: string[]
    severity?: string
    score?: number
    description?: string
    summary?: string
    timestamp?: number
    permalink?: string
    references: string[]
    vulnerableRange?: string
    firstPatchedVersion?: string
    /** The exact installed version the scanner matched — the range fallback. */
    installedVersion?: string
}

// ---------------------------------------------------------------------------
// Per-tool parsers (pure, unit-testable)
// ---------------------------------------------------------------------------

export function trivyFindings(report: TrivyReport): RawFinding[] {
    const findings: RawFinding[] = []
    for (const result of report.Results ?? []) {
        for (const vuln of result.Vulnerabilities ?? []) {
            if (!vuln.VulnerabilityID) continue
            const {keys, dedupKey} = packageKeys(vuln.PkgIdentifier?.PURL, vuln.PkgName, vuln.InstalledVersion)
            if (keys.length === 0) continue

            let score: number | undefined
            for (const entry of Object.values(vuln.CVSS ?? {})) {
                const s = entry.V3Score ?? entry.V2Score
                if (s !== undefined && (score === undefined || s > score)) score = s
            }

            const timestamp = vuln.PublishedDate ? Date.parse(vuln.PublishedDate) : NaN
            findings.push({
                packageKeys: keys,
                packageDedupKey: dedupKey,
                ids: [vuln.VulnerabilityID, ...(vuln.VendorIDs ?? [])],
                severity: vuln.Severity?.toUpperCase(),
                score,
                description: vuln.Description,
                summary: vuln.Title,
                timestamp: Number.isNaN(timestamp) ? undefined : timestamp,
                permalink: vuln.PrimaryURL,
                references: vuln.References ?? [],
                // Trivy reports no vulnerable range against an SBOM, only the fix version.
                firstPatchedVersion: vuln.FixedVersion?.split(',')[0]?.trim() || undefined,
                installedVersion: vuln.InstalledVersion,
            })
        }
    }
    return findings
}

export function grypeFindings(report: GrypeReport): RawFinding[] {
    const findings: RawFinding[] = []
    for (const match of report.matches ?? []) {
        const vuln = match.vulnerability
        const artifact = match.artifact
        if (!vuln?.id) continue
        const {keys, dedupKey} = packageKeys(artifact?.purl, artifact?.name, artifact?.version)
        if (keys.length === 0) continue

        const related = match.relatedVulnerabilities ?? []
        const ids = [vuln.id, ...related.map(r => r.id).filter((id): id is string => !!id)]

        // Prefer a CVSS v3 base score, fall back to any base score.
        const cvss = vuln.cvss ?? []
        const score = cvss.find(c => c.version?.startsWith('3'))?.metrics?.baseScore
            ?? cvss.find(c => c.metrics?.baseScore !== undefined)?.metrics?.baseScore

        // Grype GHSA records often have an empty description; the related CVE record has one.
        const description = vuln.description || related.find(r => r.description)?.description

        // Grype suffixes constraints with the version format, e.g. '>=2.4,<2.12.2 (unknown)'.
        const constraints = (match.matchDetails ?? [])
            .map(d => d.found?.versionConstraint?.replace(/\s*\([^)]*\)\s*$/, ''))
            .filter((c): c is string => !!c && c !== 'none')

        findings.push({
            packageKeys: keys,
            packageDedupKey: dedupKey,
            ids,
            severity: vuln.severity?.toUpperCase(),
            score,
            description,
            permalink: vuln.dataSource ?? vuln.urls?.[0],
            references: [
                ...(vuln.urls ?? []),
                ...related.flatMap(r => r.urls ?? []),
            ],
            vulnerableRange: constraints[0],
            firstPatchedVersion: vuln.fix?.versions?.[0],
            installedVersion: artifact?.version,
        })
    }
    return findings
}

// ---------------------------------------------------------------------------
// Cross-tool merge (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Unions Trivy and Grype findings into a package-key -> Vulnerability[] index.
 *
 * Dedup key: (normalized name@version key, canonical vulnerability id). Field-level merge on
 * collision: Grype's vulnerableRange and score win, Trivy's timestamp wins, references and
 * identifiers union; the remaining fields keep the first non-empty value.
 *
 * Every finding gets a vulnerableRange: Grype's constraint when known, otherwise the exact
 * installed version (`=1.2.3`). The scanners already matched the SBOM's exact version, so a
 * range-filter downstream must never drop these findings.
 */
export function buildVulnerabilityIndex(trivy: TrivyReport | undefined, grype: GrypeReport | undefined): Map<string, Vulnerability[]> {
    interface Merged extends RawFinding {
        canonical: string
    }

    const merged = new Map<string, Merged>()

    const add = (finding: RawFinding, preferIncoming: {range: boolean, score: boolean, timestamp: boolean}) => {
        const canonical = canonicalId(finding.ids)
        if (!canonical) return
        const key = `${finding.packageDedupKey ?? finding.packageKeys[0]}|${canonical.toUpperCase()}`
        const existing = merged.get(key)
        if (!existing) {
            merged.set(key, {...finding, canonical})
            return
        }
        // Union identity and references, merge fields by preference.
        for (const k of finding.packageKeys) {
            if (!existing.packageKeys.includes(k)) existing.packageKeys.push(k)
        }
        for (const id of finding.ids) {
            if (!existing.ids.some(e => e.toUpperCase() === id.toUpperCase())) existing.ids.push(id)
        }
        for (const ref of finding.references) {
            if (!existing.references.includes(ref)) existing.references.push(ref)
        }
        if (finding.vulnerableRange && (preferIncoming.range || !existing.vulnerableRange)) {
            existing.vulnerableRange = finding.vulnerableRange
        }
        if (finding.score !== undefined && (preferIncoming.score || existing.score === undefined)) {
            existing.score = finding.score
        }
        if (finding.timestamp !== undefined && (preferIncoming.timestamp || existing.timestamp === undefined)) {
            existing.timestamp = finding.timestamp
        }
        existing.severity = existing.severity ?? finding.severity
        existing.description = existing.description || finding.description
        existing.summary = existing.summary || finding.summary
        existing.permalink = existing.permalink || finding.permalink
        existing.firstPatchedVersion = existing.firstPatchedVersion || finding.firstPatchedVersion
    }

    if (trivy) {
        for (const f of trivyFindings(trivy)) add(f, {range: false, score: false, timestamp: true})
    }
    if (grype) {
        for (const f of grypeFindings(grype)) add(f, {range: true, score: true, timestamp: false})
    }

    const index = new Map<string, Vulnerability[]>()
    for (const f of merged.values()) {
        const vulnerability: Vulnerability = {
            severity: f.severity ?? 'UNKNOWN',
            score: f.score,
            description: f.description ?? '',
            summary: f.summary,
            timestamp: f.timestamp,
            permalink: f.permalink ?? '',
            identifiers: f.ids.map(id => ({value: id, type: identifierType(id)})),
            references: f.references,
            // The scanners matched the exact installed version, so a missing range must not read
            // as "not vulnerable" downstream — pin it to that version.
            vulnerableRange: f.vulnerableRange ?? (f.installedVersion ? `=${f.installedVersion}` : undefined),
            firstPatchedVersion: f.firstPatchedVersion,
        }
        for (const key of f.packageKeys) {
            const list = index.get(key)
            if (list) list.push(vulnerability)
            else index.set(key, [vulnerability])
        }
    }
    return index
}

// ---------------------------------------------------------------------------
// Scanner execution + per-file cache
// ---------------------------------------------------------------------------

export interface LocalScanResult {
    /** True when at least one scanner produced a report — empty columns are then a true result. */
    available: boolean
    index: Map<string, Vulnerability[]>
}

async function runScanner(tool: string, bin: string, args: string[], sbomFile: string): Promise<string | undefined> {
    const started = Date.now()
    try {
        const {stdout} = await execFileAsync(bin, args, {maxBuffer: MAX_SCANNER_OUTPUT_BYTES})
        log.info(`${tool} scan of ${path.basename(sbomFile)} done in ${((Date.now() - started) / 1000).toFixed(1)}s`)
        return stdout
    } catch (e: any) {
        const reason = e?.code === 'ENOENT'
            ? `binary '${bin}' not found (set ${tool.toUpperCase()}_BIN or add it to PATH)`
            : `${e?.message ?? e}`.split('\n')[0]
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

async function scanFile(sbomFile: string): Promise<LocalScanResult> {
    if (!fs.existsSync(sbomFile)) {
        log.warn(`Local vulnerability scan skipped: ${sbomFile} does not exist`)
        return {available: false, index: new Map()}
    }

    const trivyBin = process.env.TRIVY_BIN || 'trivy'
    const grypeBin = process.env.GRYPE_BIN || 'grype'

    // The two scanners are independent — run them in parallel.
    const [trivyJson, grypeJson] = await Promise.all([
        runScanner('trivy', trivyBin, ['sbom', '--format', 'json', sbomFile], sbomFile),
        runScanner('grype', grypeBin, [`sbom:${sbomFile}`, '-o', 'json'], sbomFile),
    ])

    const trivy = parseReport<TrivyReport>('trivy', trivyJson)
    const grype = parseReport<GrypeReport>('grype', grypeJson)

    if (!trivy && !grype) {
        log.warn(`No local vulnerability scanner available for ${path.basename(sbomFile)} — vulnerability columns will be empty`)
        return {available: false, index: new Map()}
    }

    const index = buildVulnerabilityIndex(trivy, grype)
    let findings = 0
    for (const list of index.values()) findings += list.length
    log.info(`Local scan of ${path.basename(sbomFile)}: ${findings} finding entries across ${index.size} package keys`
        + ` (trivy: ${trivy ? 'ok' : 'skipped'}, grype: ${grype ? 'ok' : 'skipped'})`)
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

/** Exposed for tests. */
export function clearLocalScanCache(): void {
    scanCache.clear()
}
