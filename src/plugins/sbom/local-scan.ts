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
 *
 * Which binaries exist, and at what version, is established ONCE up front by `preflightScanners()`
 * so the user is told before the run rather than in a warning buried mid-log, and is recorded in
 * `sbom-scan-provenance.json` so a count can be traced back to the matcher that produced it.
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
// Preflight: are the scanners there, and are they the versions we pinned?
// ---------------------------------------------------------------------------

/**
 * The reference scanner pair, pinned by documentation — see DECISIONS.md D-16.
 *
 * Nothing here vendors or downloads a binary: depinder runs on machines we control, so the pin is
 * a convention that the code VERIFIES and RECORDS rather than enforces. A mismatch is a warning,
 * never a failure — an intentional upgrade must not block a run. When you deliberately move to a
 * new pair, re-measure, update these constants AND the table in D-16, and note what moved.
 */
export const PINNED_SCANNER_VERSIONS: {readonly trivy: string, readonly grype: string} = {
    trivy: '0.72.0',
    grype: '0.115.0',
}

export type ScannerName = 'trivy' | 'grype'

/** What one scanner is, as observed on this machine — the unit of both messaging and provenance. */
export interface ScannerStatus {
    tool: ScannerName
    /** The resolved binary: TRIVY_BIN/GRYPE_BIN if set, else the bare name looked up on PATH. */
    bin: string
    installed: boolean
    version?: string
    pinnedVersion: string
    /** False also when the version could not be read at all — unknown is not "as pinned". */
    versionMatchesPin: boolean
    /** Trivy: DB schema version. Grype: DB schema version (e.g. `v6.1.9`). */
    dbVersion?: string
    /** Trivy: `VulnerabilityDB.UpdatedAt`. Grype: `built` from `grype db status`. */
    dbBuiltAt?: string
    /** Why the probe failed, when it did — the text the user is shown to fix it. */
    error?: string
}

export interface ScannerPreflight {
    trivy: ScannerStatus
    grype: ScannerStatus
    /** 2 = full coverage, 1 = partial, 0 = no local scanning at all. */
    installedCount: number
}

export interface PreflightMessage {
    level: 'info' | 'warn'
    text: string
}

function scannerBin(tool: ScannerName): string {
    return (tool === 'trivy' ? process.env.TRIVY_BIN : process.env.GRYPE_BIN) || tool
}

/** A short, actionable reason — this text ends up in front of the user, not just in the log. */
function probeFailure(tool: ScannerName, bin: string, e: any): string {
    if (e?.code === 'ENOENT') {
        const envVar = `${tool.toUpperCase()}_BIN`
        return `binary '${bin}' not found — install ${tool}, or set ${envVar} to its full path`
    }
    return `${e?.message ?? e}`.split('\n')[0]
}

async function probeTrivy(): Promise<ScannerStatus> {
    const bin = scannerBin('trivy')
    const status: ScannerStatus = {
        tool: 'trivy', bin, installed: false, pinnedVersion: PINNED_SCANNER_VERSIONS.trivy,
        versionMatchesPin: false,
    }
    try {
        const {stdout} = await execFileAsync(bin, ['--version', '--format', 'json'])
        status.installed = true
        // A stub or an older CLI may not honour `--format json`; the binary still exists and can
        // still scan, so a version we cannot read degrades to "unknown", not to "missing".
        const report = JSON.parse(stdout) as {Version?: string, VulnerabilityDB?: {Version?: number, UpdatedAt?: string}}
        status.version = report.Version
        status.dbVersion = report.VulnerabilityDB?.Version !== undefined ? String(report.VulnerabilityDB.Version) : undefined
        status.dbBuiltAt = report.VulnerabilityDB?.UpdatedAt
    } catch (e: any) {
        if (!status.installed) status.error = probeFailure('trivy', bin, e)
    }
    status.versionMatchesPin = status.version === status.pinnedVersion
    return status
}

async function probeGrype(): Promise<ScannerStatus> {
    const bin = scannerBin('grype')
    const status: ScannerStatus = {
        tool: 'grype', bin, installed: false, pinnedVersion: PINNED_SCANNER_VERSIONS.grype,
        versionMatchesPin: false,
    }
    try {
        const {stdout} = await execFileAsync(bin, ['version', '-o', 'json'])
        status.installed = true
        status.version = (JSON.parse(stdout) as {version?: string}).version
    } catch (e: any) {
        if (!status.installed) status.error = probeFailure('grype', bin, e)
    }
    if (status.installed) {
        // Grype keeps the DB build date in a separate command; a missing DB must not read as a
        // missing scanner, since grype downloads it on first scan.
        try {
            const {stdout} = await execFileAsync(bin, ['db', 'status', '-o', 'json'])
            const db = JSON.parse(stdout) as {schemaVersion?: string, built?: string}
            status.dbVersion = db.schemaVersion
            status.dbBuiltAt = db.built
        } catch {
            // Left undefined — reported as "DB unknown" rather than treated as an error.
        }
    }
    status.versionMatchesPin = status.version === status.pinnedVersion
    return status
}

let preflightPromise: Promise<ScannerPreflight> | undefined

/** Probes both scanners once per process. Never throws — a broken probe is a reported state. */
export function preflightScanners(): Promise<ScannerPreflight> {
    if (!preflightPromise) {
        preflightPromise = (async () => {
            const [trivy, grype] = await Promise.all([probeTrivy(), probeGrype()])
            return {trivy, grype, installedCount: (trivy.installed ? 1 : 0) + (grype.installed ? 1 : 0)}
        })()
    }
    return preflightPromise
}

function describe(status: ScannerStatus): string {
    const db = status.dbVersion || status.dbBuiltAt
        ? `DB ${status.dbVersion ?? 'unknown'}${status.dbBuiltAt ? `, built ${status.dbBuiltAt}` : ''}`
        : 'DB unknown'
    return `${status.tool} ${status.version ?? 'version unknown'} (${db})`
}

const BANNER = '='.repeat(78)

/**
 * The user-facing verdict, as a list of lines for the caller to log.
 *
 * Kept pure and separate from logging so the exact wording is testable — this is the only place a
 * user learns that vulnerability data is missing, and a run that ends with silently empty columns
 * is the failure mode this exists to prevent.
 */
export function scannerPreflightMessages(preflight: ScannerPreflight, hasGithubToken: boolean): PreflightMessage[] {
    const messages: PreflightMessage[] = []
    const {trivy, grype} = preflight
    const installed = [trivy, grype].filter(it => it.installed)
    const missing = [trivy, grype].filter(it => !it.installed)

    if (installed.length > 0) {
        messages.push({level: 'info', text: `Vulnerability scanners: ${installed.map(describe).join(', ')}`})
    }

    for (const status of installed) {
        if (status.versionMatchesPin) continue
        messages.push({
            level: 'warn',
            text: `${status.tool} ${status.version ?? '(version unreadable)'} differs from the pinned reference `
                + `version ${status.pinnedVersion} (DECISIONS.md D-16) — counts are not directly comparable with `
                + 'earlier runs. If the change is intentional, re-measure and update D-16.',
        })
    }

    if (missing.length === 1) {
        const gone = missing[0]
        messages.push({level: 'warn', text: BANNER})
        messages.push({level: 'warn', text: `PARTIAL vulnerability analysis: ${gone.tool} is not available`})
        messages.push({level: 'warn', text: `  ${gone.tool}: ${gone.error ?? 'unavailable'}`})
        messages.push({
            level: 'warn',
            text: '  Trivy and Grype find substantially different sets of vulnerabilities; the results '
                + 'below\n  come from one tool only and are incomplete.',
        })
        messages.push({level: 'warn', text: BANNER})
    }

    if (missing.length === 2) {
        messages.push({level: 'warn', text: BANNER})
        messages.push({level: 'warn', text: 'NO local vulnerability scanner available — neither Trivy nor Grype could be run'})
        for (const gone of missing) messages.push({level: 'warn', text: `  ${gone.tool}: ${gone.error ?? 'unavailable'}`})
        if (hasGithubToken) {
            messages.push({
                level: 'warn',
                text: '  FALLBACK: GH_TOKEN is set, so vulnerabilities come from the GitHub Advisory\n'
                    + '  database instead. That covers fewer ecosystems and no OS packages, and it\n'
                    + '  matches by advisory range rather than by scanning the SBOM.',
            })
        } else {
            messages.push({
                level: 'warn',
                text: '  VULNERABILITY ANALYSIS IS DISABLED. The vulnerability columns in the CSVs\n'
                    + '  will be empty — that is a missing measurement, not a clean bill of health.\n'
                    + '  Set GH_TOKEN to fall back to the GitHub Advisory database.',
            })
        }
        messages.push({level: 'warn', text: BANNER})
    }

    return messages
}

/** The one-line reminder repeated at the end of the run, where the results paths are printed. */
export function scannerSummaryLine(preflight: ScannerPreflight, hasGithubToken: boolean): PreflightMessage {
    const installed = [preflight.trivy, preflight.grype].filter(it => it.installed)
    if (installed.length === 2) {
        return {level: 'info', text: `Vulnerability data source: ${installed.map(it => `${it.tool} ${it.version ?? '?'}`).join(' + ')}`}
    }
    if (installed.length === 1) {
        const gone = [preflight.trivy, preflight.grype].find(it => !it.installed) as ScannerStatus
        return {
            level: 'warn',
            text: `Vulnerability data source: ${installed[0].tool} only — PARTIAL, ${gone.tool} was not available`,
        }
    }
    return hasGithubToken
        ? {level: 'warn', text: 'Vulnerability data source: GitHub Advisories (fallback) — no local scanner ran'}
        : {level: 'warn', text: 'Vulnerability data source: NONE — the vulnerability columns are empty because no scanner ran'}
}

// ---------------------------------------------------------------------------
// Provenance of the run
// ---------------------------------------------------------------------------

/** What one SBOM file's scan actually produced — the per-file half of the provenance record. */
export interface ScannedFileRecord {
    file: string
    trivy: 'ok' | 'skipped'
    grype: 'ok' | 'skipped'
    findingEntries: number
    packageKeys: number
}

const scannedFiles = new Map<string, ScannedFileRecord>()

export const PROVENANCE_FILE = 'sbom-scan-provenance.json'

/**
 * Records how the vulnerability numbers in the CSVs were produced.
 *
 * A count without its matcher and DB build date is untraceable: two runs a week apart can disagree
 * by tens of percent for entirely legitimate reasons, and without this file that is indistinguishable
 * from a regression (DECISIONS.md D-16). One file per run, not a column per row.
 */
export async function writeScanProvenance(resultFolder: string, hasGithubToken: boolean): Promise<string> {
    const preflight = await preflightScanners()
    const provenance = {
        generatedAt: new Date().toISOString(),
        decision: 'DECISIONS.md D-16 — scanner versions pinned by documentation, verified at runtime, recorded here',
        pinnedVersions: PINNED_SCANNER_VERSIONS,
        scanners: {
            trivy: preflight.trivy,
            grype: preflight.grype,
        },
        githubAdvisoryFallback: preflight.installedCount === 0 && hasGithubToken,
        vulnerabilityAnalysis: preflight.installedCount > 0
            ? (preflight.installedCount === 2 ? 'complete' : 'partial')
            : (hasGithubToken ? 'github-advisories-only' : 'disabled'),
        sbomFiles: [...scannedFiles.values()],
    }
    const file = path.resolve(resultFolder, PROVENANCE_FILE)
    fs.writeFileSync(file, JSON.stringify(provenance, null, 2))
    return file
}

// ---------------------------------------------------------------------------
// Scanner execution + per-file cache
// ---------------------------------------------------------------------------

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

    // Preflight already established which binaries exist; do not re-discover it per file.
    const preflight = await preflightScanners()

    // The two scanners are independent — run them in parallel.
    const [trivyJson, grypeJson] = await Promise.all([
        preflight.trivy.installed
            ? runScanner('trivy', preflight.trivy.bin, ['sbom', '--format', 'json', sbomFile], sbomFile)
            : Promise.resolve(undefined),
        preflight.grype.installed
            ? runScanner('grype', preflight.grype.bin, [`sbom:${sbomFile}`, '-o', 'json'], sbomFile)
            : Promise.resolve(undefined),
    ])

    const trivy = parseReport<TrivyReport>('trivy', trivyJson)
    const grype = parseReport<GrypeReport>('grype', grypeJson)

    const record: ScannedFileRecord = {
        file: sbomFile,
        trivy: trivy ? 'ok' : 'skipped',
        grype: grype ? 'ok' : 'skipped',
        findingEntries: 0,
        packageKeys: 0,
    }
    scannedFiles.set(sbomFile, record)

    if (!trivy && !grype) {
        log.warn(`No local vulnerability scanner available for ${path.basename(sbomFile)} — vulnerability columns will be empty`)
        return {available: false, index: new Map()}
    }

    const index = buildVulnerabilityIndex(trivy, grype)
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
    scannedFiles.clear()
    preflightPromise = undefined
}
