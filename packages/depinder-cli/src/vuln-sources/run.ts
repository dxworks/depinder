import fs from 'fs'
import path from 'path'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {Plugin} from '../extension-points/plugin'
import {Vulnerability} from '../extension-points/vulnerability-checker'
import {
    attachLocalFindings,
    attachServerFindings,
    purlTypeOfPlugin,
    sbomPlugins,
    sbomProjectsOf,
} from '../plugins/sbom'
import {SbomDescription} from '../plugins/sbom/describe'
import {
    PreflightMessage,
    PROVENANCE_FILE,
    preflightScanners,
    ScannerPreflight,
    scannerPreflightMessages,
    scannerSummaryLine,
    scanSbomFileOnce,
} from '../plugins/sbom/local-scan'
import {log} from '../utils/logging'
import {count, startPhase, timePhase} from '../utils/profile'
import {
    describeServerScanners,
    fetchServerVulnerabilities,
    staleBuildWarnings,
    VulnDatabaseBuild,
    VulnServerAnswer,
    VulnServerConfig,
} from './server'
import {vulnSources} from './selection'

/**
 * Where an SBOM run's vulnerabilities come from: the vulnerability server, or — when it is not
 * configured, not selected, or fails — Trivy and Grype on this machine, exactly as before.
 *
 * With a server, the question is asked at the very start of the run, for every purl of every run,
 * and nothing waits for it until the findings are actually read: the cache load, the parse, the
 * purls and the resolver's bulk phase all go ahead meanwhile. The SBOM parser is told to leave the
 * findings alone (`deferSbomFindings`), and they are attached here, onto the same memoised project
 * objects the parser hands out, the moment the answer is in. If it does not come, the local scan
 * runs instead and attaches its findings the way the parser always has.
 */

/** One project the SBOM route will parse, with the plugin and file it comes from. */
export interface SbomTarget {
    plugin: Plugin
    /** Absolute, as the parser resolves it. */
    file: string
    project: DepinderProject
}

/**
 * Every project every run will parse, from the very parse the SBOM parser memoises — so the
 * parser later hands out these same objects, and whatever is attached to them here is what it
 * returns. `filesFor` is the extractor's own file filter (`filesForPlugin`). A file that does not
 * parse is skipped; the parser will report it, as it always has.
 */
export function collectSbomTargets(
    runs: {plugins: Plugin[], files: string[]}[],
    filesFor: (plugin: Plugin, files: string[]) => string[],
): SbomTarget[] {
    const targets: SbomTarget[] = []
    const seen = new Set<DepinderProject>()
    for (const run of runs) {
        for (const plugin of run.plugins) {
            const purlType = purlTypeOfPlugin(plugin)
            if (!purlType || !sbomPlugins.includes(plugin)) continue
            for (const file of filesFor(plugin, run.files)) {
                const absolute = path.resolve(file)
                let projects: DepinderProject[]
                try {
                    projects = sbomProjectsOf(absolute, purlType)
                } catch {
                    continue
                }
                for (const project of projects) {
                    if (seen.has(project)) continue
                    seen.add(project)
                    targets.push({plugin, file: absolute, project})
                }
            }
        }
    }
    return targets
}

/**
 * The purl a dependency is looked up by: the SBOM's own, else the one `assignPurls` will give it
 * later from the plugin's `getPURL` — computed the same way, so the purl asked about up front is
 * the purl the dependency ends up with.
 */
export function vulnLookupPurl(plugin: Plugin, dep: DepinderDependency): string | undefined {
    if (dep.purl) return dep.purl
    const version = dep.version?.trim()
    const getPURL = plugin.checker?.getPURL
    return version && getPURL ? getPURL(dep.name, version) : undefined
}

/** Per SBOM file, what the server's answer amounted to — the per-file half of the provenance. */
export interface ServerFileRecord {
    file: string
    /** Distinct purls of this file that were asked about. */
    purls: number
    /** How many of them have findings. */
    vulnerablePurls: number
    /** Findings over those distinct purls. */
    findingEntries: number
}

export type VulnOutcome =
    | {source: 'server', server: string, answer: VulnServerAnswer, files: ServerFileRecord[]}
    | {source: 'local', preflight?: ScannerPreflight, fallbackReason?: string}

/**
 * The local scanner preflight, said out loud: run once, never abort — a run without scanners is
 * degraded, not invalid.
 */
export async function localScannerPreflight(hasGithubToken: boolean): Promise<ScannerPreflight> {
    const preflight = await timePhase('preflight', () => preflightScanners())
    for (const message of scannerPreflightMessages(preflight, hasGithubToken)) log[message.level](message.text)
    return preflight
}

/**
 * Trivy and Grype run on every SBOM a plugin will parse, all at once and up front. Each file is
 * scanned exactly once either way — the parser memoises — but the parser reaches the files one
 * project at a time, which serialised a dozen one-to-two-second Grype runs.
 */
export async function localPrescan(files: () => string[]): Promise<void> {
    await timePhase('scan:prescan', () => Promise.all(files().map(file => scanSbomFileOnce(file))))
}

function serverHost(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return url
    }
}

function attachFromServer(targets: SbomTarget[], answer: VulnServerAnswer): ServerFileRecord[] {
    const none: Vulnerability[] = []
    const perFile = new Map<string, {purls: Set<string>, vulnerable: Set<string>, findings: number}>()
    for (const {plugin, file, project} of targets) {
        let stats = perFile.get(file)
        if (!stats) perFile.set(file, stats = {purls: new Set(), vulnerable: new Set(), findings: 0})
        const record = stats
        attachServerFindings(file, project, dep => {
            const purl = vulnLookupPurl(plugin, dep)
            if (!purl) return none
            const findings = answer.vulnerabilities.get(purl)
            if (!record.purls.has(purl)) {
                record.purls.add(purl)
                if (findings?.length) {
                    record.vulnerable.add(purl)
                    record.findings += findings.length
                }
            }
            return findings ?? none
        })
    }
    return [...perFile].map(([file, stats]) => ({
        file, purls: stats.purls.size, vulnerablePurls: stats.vulnerable.size, findingEntries: stats.findings,
    }))
}

/**
 * Asks the vulnerability server about every purl of `targets`, and resolves once every target has
 * its findings — the server's, or the local scan's if the server did not answer in full.
 *
 * Returns at once; the promise never rejects. `githubReady` is the GitHub advisory refresh, which
 * the server's findings are merged with and so must wait for. `prescanFiles` are the files today's
 * up-front local scan covers, scanned only if the run falls back.
 */
export function startServerVulnerabilities(
    config: VulnServerConfig,
    targets: SbomTarget[],
    options: {githubReady: Promise<unknown>, prescanFiles: () => string[], hasGithubToken: boolean},
): Promise<VulnOutcome> {
    const purls = new Set<string>()
    for (const {plugin, project} of targets) {
        for (const dep of Object.values(project.dependencies)) {
            const purl = vulnLookupPurl(plugin, dep)
            if (purl) purls.add(purl)
        }
    }
    count('vuln:purls', purls.size)
    log.info(`Asking the vulnerability server at ${config.url} about ${purls.size} purl(s), `
        + `waiting at most ${Math.round(config.maxWaitMs / 1000)}s for it`)

    const asked = startPhase('vuln:server')
    const outcome = (async (): Promise<VulnOutcome> => {
        const result = await fetchServerVulnerabilities(config, purls)
        asked.end()
        let reason: string
        if (result.ok) {
            for (const [metric, ms] of Object.entries(result.answer.serverTiming)) {
                count(`vuln:server-timing:${metric}-ms`, Math.round(ms))
            }
            await options.githubReady.catch(() => undefined)
            try {
                const files = attachFromServer(targets, result.answer)
                for (const warning of staleBuildWarnings(result.answer)) log.warn(warning)
                return {source: 'server', server: serverHost(config.url), answer: result.answer, files}
            } catch (e: any) {
                reason = `its answer could not be applied: ${e?.message ?? e}`
            }
        } else {
            reason = result.reason
        }

        // The fallback is the local path exactly as it runs without a server: preflight, one
        // database refresh, every SBOM scanned at once, findings attached as the parser does.
        count('vuln:fallback')
        log.warn(`Vulnerability server unavailable (${reason}); scanning the SBOMs locally with Trivy and Grype instead`)
        const preflight = await localScannerPreflight(options.hasGithubToken)
        await localPrescan(options.prescanFiles)
        await options.githubReady.catch(() => undefined)
        for (const {file, project} of targets) await attachLocalFindings(file, project)
        return {source: 'local', preflight, fallbackReason: reason}
    })()
    return outcome.catch((e: any): VulnOutcome => {
        log.warn(`Vulnerability analysis failed: ${e?.message ?? e}`)
        return {source: 'local', fallbackReason: `${e?.message ?? e}`}
    })
}

function oldest(builds: VulnDatabaseBuild[]): VulnDatabaseBuild | undefined {
    return builds[0]
}

/**
 * `sbom-scan-provenance.json` for a run whose findings came from the server: which server, which
 * scanner versions and which database builds answered, and per file what the answer amounted to.
 */
export function writeServerProvenance(
    resultFolder: string,
    outcome: Extract<VulnOutcome, {source: 'server'}>,
    sboms?: SbomDescription[],
): string {
    const {answer} = outcome
    const sbomFiles = sboms
        ? outcome.files.flatMap(record => {
            const sbom = sboms.find(it => path.resolve(it.file) === record.file)
            return sbom ? [{...record, producer: sbom.producer, producerVersion: sbom.toolVersion, repo: sbom.repo}] : []
        })
        : outcome.files
    const several = answer.databases.trivy.length > 1 || answer.databases.grype.length > 1
    const provenance = {
        generatedAt: new Date().toISOString(),
        ...(sboms?.length ? {source: sboms[0].producer} : {}),
        vulnerabilitySource: 'server',
        vulnerabilityServer: outcome.server,
        scanners: {trivy: answer.scanners.trivy.join(', ') || undefined, grype: answer.scanners.grype.join(', ') || undefined},
        databases: {trivy: oldest(answer.databases.trivy), grype: oldest(answer.databases.grype)},
        ...(several ? {databaseBuilds: answer.databases} : {}),
        githubAdvisories: vulnSources().github,
        vulnerabilityAnalysis: 'complete',
        sbomFiles,
    }
    const file = path.resolve(resultFolder, PROVENANCE_FILE)
    fs.writeFileSync(file, JSON.stringify(provenance, null, 2))
    return file
}

/** The end-of-run reminder of where the vulnerability columns came from. */
export function vulnSummaryLine(outcome: VulnOutcome, hasGithubToken: boolean): PreflightMessage | undefined {
    if (outcome.source === 'server') {
        const stale = staleBuildWarnings(outcome.answer).length > 0
        return {
            level: stale ? 'warn' : 'info',
            text: `Vulnerability data source: vulnerability server ${outcome.server}, ${describeServerScanners(outcome.answer)}`
                + `${stale ? ' — a database build is STALE' : ''}`,
        }
    }
    if (!outcome.preflight) return undefined
    const local = scannerSummaryLine(outcome.preflight, hasGithubToken)
    return outcome.fallbackReason
        ? {level: 'warn', text: `${local.text} (local scan: the vulnerability server failed: ${outcome.fallbackReason})`}
        : local
}
