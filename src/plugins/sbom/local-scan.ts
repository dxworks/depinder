import {execFile} from 'child_process'
import fs from 'fs'
import path from 'path'
import {promisify} from 'util'
import {Vulnerability} from '../../extension-points/vulnerability-checker'
import {parsePurl} from './cyclonedx'
import {vulnSources} from '../../vuln-sources/selection'
import {log} from '../../utils/logging'
import {SbomDescription} from './describe'
import {timePhase} from '../../utils/profile'

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
            CweIDs?: string[]
            CVSS?: { [source: string]: { V40Score?: number, V3Score?: number, V2Score?: number, V40Vector?: string, V3Vector?: string, V2Vector?: string } }
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
            cvss?: { source?: string, version?: string, vector?: string, metrics?: { baseScore?: number } }[]
            fix?: { versions?: string[] }
        }
        relatedVulnerabilities?: {
            id?: string
            description?: string
            dataSource?: string
            urls?: string[]
            cvss?: { source?: string, version?: string, vector?: string, metrics?: { baseScore?: number } }[]
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
export function canonicalId(ids: string[]): string | undefined {
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
    patchedVersions?: string[]
    /** The exact installed version the scanner matched — the range fallback. */
    installedVersion?: string
    source: string
    cvssVector?: string
    cvssVersion?: string
    cweIds?: string[]
}

// ---------------------------------------------------------------------------
// Per-tool parsers (pure, unit-testable)
// ---------------------------------------------------------------------------

/** `2.15.0, 2.12.2` -> `['2.15.0', '2.12.2']`; empty and blank cells give `undefined`. */
function fixedVersions(cell: string | undefined): string[] | undefined {
    const versions = (cell ?? '').split(',').map(it => it.trim()).filter(Boolean)
    return versions.length > 0 ? versions : undefined
}

type TrivyCvss = NonNullable<NonNullable<NonNullable<TrivyReport['Results']>[number]['Vulnerabilities']>[number]['CVSS']>

interface ChosenCvss {
    score?: number
    cvssVector?: string
    cvssVersion?: string
}

/**
 * Trivy reports one CVSS block per scoring source (`ghsa`, `nvd`, `redhat`, …). GHSA's block wins
 * — it is the catalogue that knows the package, and the one our ids are named after — then NVD's,
 * then whatever else scores highest. Within a block the newest CVSS wins: `V40Score` (trivy 0.6x+;
 * older reports put a `CVSS:4.0` vector under `V3Vector`), then `V3Score`, then `V2Score`. Score
 * and vector always come from the same block, so they agree.
 */
export function trivyCvss(cvss: TrivyCvss | undefined): ChosenCvss {
    const entries = Object.entries(cvss ?? {})
    const fromBlock = (entry: TrivyCvss[string]): ChosenCvss | undefined => {
        if (entry.V40Score !== undefined) return {score: entry.V40Score, cvssVector: entry.V40Vector, cvssVersion: '4.0'}
        if (entry.V3Score !== undefined) {
            return {score: entry.V3Score, cvssVector: entry.V3Vector,
                cvssVersion: entry.V3Vector?.startsWith('CVSS:4') ? '4.0' : entry.V3Vector?.startsWith('CVSS:3.0') ? '3.0' : '3.1'}
        }
        if (entry.V2Score !== undefined) return {score: entry.V2Score, cvssVector: entry.V2Vector, cvssVersion: '2.0'}
        return undefined
    }
    for (const preferred of ['ghsa', 'nvd']) {
        const block = entries.find(([source]) => source.toLowerCase() === preferred)?.[1]
        const chosen = block && fromBlock(block)
        if (chosen) return chosen
    }
    let chosen: ChosenCvss = {}
    for (const [, entry] of entries) {
        const candidate = fromBlock(entry)
        if (candidate?.score !== undefined && (chosen.score === undefined || candidate.score > chosen.score)) chosen = candidate
    }
    return chosen
}

export function trivyFindings(report: TrivyReport): RawFinding[] {
    const findings: RawFinding[] = []
    for (const result of report.Results ?? []) {
        for (const vuln of result.Vulnerabilities ?? []) {
            if (!vuln.VulnerabilityID) continue
            const {keys, dedupKey} = packageKeys(vuln.PkgIdentifier?.PURL, vuln.PkgName, vuln.InstalledVersion)
            if (keys.length === 0) continue

            const {score, cvssVector, cvssVersion} = trivyCvss(vuln.CVSS)

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
                // Trivy reports no vulnerable range against an SBOM, only the fix versions — one
                // per maintained line, highest first (`2.15.0, 2.12.2`). All of them are kept.
                firstPatchedVersion: vuln.FixedVersion?.split(',')[0]?.trim() || undefined,
                patchedVersions: fixedVersions(vuln.FixedVersion),
                installedVersion: vuln.InstalledVersion,
                source: 'trivy',
                cvssVector,
                cvssVersion,
                cweIds: vuln.CweIDs,
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

        // GHSA's own score first (the GHSA record's block, or an entry sourced from GitHub), then
        // NVD's — which sits on the related CVE record, not on the GHSA one — then any score.
        type GrypeCvss = {source?: string, version?: string, vector?: string, metrics?: {baseScore?: number}}
        const scored = (list: GrypeCvss[] | undefined) => (list ?? []).filter(c => c.metrics?.baseScore !== undefined)
        const own = scored(vuln.cvss)
        const all = [...own, ...related.flatMap(r => scored(r.cvss))]
        const isGithub = (c: GrypeCvss) => (c.source ?? '').toLowerCase().includes('github')
        const isNvd = (c: GrypeCvss) => (c.source ?? '').toLowerCase().includes('nvd')
        // Within a group, the newest CVSS version wins (4.0 over 3.1 over 2.0), as on the trivy side.
        const newest = (list: GrypeCvss[]): GrypeCvss | undefined =>
            [...list].sort((a, b) => parseFloat(b.version ?? '0') - parseFloat(a.version ?? '0'))[0]
        const chosenCvss = newest(all.filter(isGithub))
            ?? (vuln.id.toUpperCase().startsWith('GHSA-') ? newest(own) : undefined)
            ?? newest(all.filter(isNvd))
            ?? newest(all)
        const score = chosenCvss?.metrics?.baseScore

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
            patchedVersions: vuln.fix?.versions?.filter(Boolean),
            installedVersion: artifact?.version,
            source: 'grype',
            cvssVector: chosenCvss?.vector,
            cvssVersion: chosenCvss?.version,
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
        for (const fixed of finding.patchedVersions ?? []) {
            if (!existing.patchedVersions?.includes(fixed)) existing.patchedVersions = [...(existing.patchedVersions ?? []), fixed]
        }
        if (!existing.source.split(',').includes(finding.source)) existing.source += `,${finding.source}`
        if (finding.cvssVector && (preferIncoming.score || !existing.cvssVector)) {
            existing.cvssVector = finding.cvssVector
            existing.cvssVersion = finding.cvssVersion
        }
        if (finding.cweIds?.length && !existing.cweIds?.length) existing.cweIds = finding.cweIds
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
            patchedVersions: f.patchedVersions?.length ? f.patchedVersions : undefined,
            source: f.source,
            cvssVector: f.cvssVector,
            cvssVersion: f.cvssVersion,
            cweIds: f.cweIds,
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
 * The reference scanner pair these results were calibrated against.
 *
 * Nothing here vendors or downloads a binary: the pin is a convention that the code VERIFIES and
 * RECORDS rather than enforces. A mismatch is a warning, never a failure — an intentional upgrade
 * must not block a run.
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
            text: `${status.tool} ${status.version ?? '(version unreadable)'} differs from the reference `
                + `version ${status.pinnedVersion} these results were calibrated against — vulnerability counts `
                + `depend on the scanner version and its DB build date, both recorded in ${PROVENANCE_FILE}.`,
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
    /** Who wrote the SBOM, when the run knows (see `describe.ts`); absent for a bare scan. */
    producer?: string
    producerVersion?: string
    repo?: string
}

const scannedFiles = new Map<string, ScannedFileRecord>()

export const PROVENANCE_FILE = 'sbom-scan-provenance.json'

/**
 * Records how the vulnerability numbers in the CSVs were produced.
 *
 * A count without its matcher and DB build date is untraceable: both scanners auto-update their
 * vulnerability databases, so the same SBOM can legitimately yield different counts a week later.
 * One file per run, not a column per row.
 */
export async function writeScanProvenance(
    resultFolder: string, hasGithubToken: boolean, sboms?: SbomDescription[],
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
    const provenance = {
        generatedAt: new Date().toISOString(),
        ...(sboms?.length ? {source: sboms[0].producer} : {}),
        pinnedVersions: PINNED_SCANNER_VERSIONS,
        scanners: {
            trivy: preflight.trivy,
            grype: preflight.grype,
        },
        githubAdvisoryFallback: preflight.installedCount === 0 && hasGithubToken,
        vulnerabilityAnalysis: preflight.installedCount > 0
            ? (preflight.installedCount === 2 ? 'complete' : 'partial')
            : (hasGithubToken ? 'github-advisories-only' : 'disabled'),
        sbomFiles,
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

/**
 * Why a scanner call failed, in one line, with the scanner's own last word kept.
 *
 * `execFile` rejects with `Command failed: trivy sbom --format json <file>` on its first line and
 * the child's stderr under it. Reporting only that first line named the command and never the
 * reason — an expired database the scanner could not re-download reads exactly like a corrupt
 * SBOM. The last stderr line that mentions a failure is the one the scanner meant as its verdict.
 */
export function scannerFailureReason(e: any): string {
    const head = `${e?.message ?? e}`.split('\n')[0]
    const lines = `${e?.stderr ?? ''}`.split('\n').map((it: string) => it.trim()).filter(Boolean)
    const detail = [...lines].reverse().find((it: string) => /error|fatal|failed|denied/i.test(it))
        ?? lines[lines.length - 1]
    return detail ? `${head} \u2014 ${detail}` : head
}

let warmPromise: Promise<void> | undefined

/**
 * Refreshes each scanner's vulnerability database once, before the first scan reads it.
 *
 * Both scanners update their DB lazily, inside the scan. With every SBOM scanned at once, an
 * expired DB meant a dozen child processes fetching the same archive simultaneously and all of
 * them failing: the run finished with empty vulnerability columns and one `Command failed` line
 * per file. Every scan awaits this single promise instead, so at most one download happens. A
 * current DB makes it a no-op — `trivy image --download-db-only` and `grype db update` both
 * return in milliseconds when there is nothing to fetch.
 */
export function warmScannerDatabases(): Promise<void> {
    if (!warmPromise) {
        warmPromise = (async () => {
            const preflight = await preflightScanners()
            const selected = vulnSources()
            const jobs: {tool: 'trivy' | 'grype', status: ScannerStatus, args: string[]}[] = [
                {tool: 'trivy', status: preflight.trivy, args: ['image', '--download-db-only']},
                {tool: 'grype', status: preflight.grype, args: ['db', 'update']},
            ]
            // The two databases are unrelated, so the tools refresh side by side; the race this
            // fixes is several processes of the SAME tool fetching the SAME archive.
            await Promise.all(jobs.filter(it => it.status.installed && selected[it.tool]).map(async ({tool, status, args}) => {
                const started = Date.now()
                try {
                    await timePhase(`db:${tool}`, () =>
                        execFileAsync(status.bin, args, {maxBuffer: MAX_SCANNER_OUTPUT_BYTES}))
                    const elapsed = (Date.now() - started) / 1000
                    // Worth a line only when it actually fetched something; a no-op stays silent.
                    if (elapsed > 2) log.info(`${tool} vulnerability DB refreshed in ${elapsed.toFixed(1)}s`)
                } catch (e: any) {
                    log.warn(`${tool} vulnerability DB refresh failed: ${scannerFailureReason(e)}`)
                    log.warn(`  ${tool} scans continue against whatever database is already on disk`)
                }
            }))
        })()
    }
    return warmPromise
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
    const record: ScannedFileRecord = {file: sbomFile, trivy: 'skipped', grype: 'skipped', findingEntries: 0, packageKeys: 0}
    scannedFiles.set(sbomFile, record)

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
    warmPromise = undefined
}
