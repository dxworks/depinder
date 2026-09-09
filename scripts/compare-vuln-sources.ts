/**
 * Scores the GitHub advisory source against Trivy and Grype, over the twelve reference projects
 * and both SBOM producers.
 *
 * Run it with:
 *
 *     npx ts-node -T scripts/compare-vuln-sources.ts
 *
 * `DEPINDER_COMPARISON_DIR` is the comparison workspace holding `inputs/voyager/sboms` and
 * `results`; it defaults to the current directory.
 *
 * (`-T` transpiles without type-checking, because this file sits outside the `src` rootDir the
 * project's tsconfig declares.)
 *
 * Method. For each (project, SBOM producer) pair the three sources are run over the SAME file, and
 * every finding is reduced to `(package, canonical id)`:
 *   - package is the purl-derived `name@version` — the one key all three agree on, since both
 *     scanners echo the SBOM's own purl.
 *   - canonical id is the finding's CVE when it has one, otherwise its GHSA. That is what makes
 *     the comparison fair: Trivy reports a CVE with the GHSA as a vendor id, Grype reports the
 *     GHSA with the CVE as a related vulnerability, and the GitHub source reports the GHSA with
 *     the CVE as an alias. Comparing primary ids alone would score three views of one advisory as
 *     three disagreements.
 *
 * Neither scanner's database is updated: `--skip-db-update` / `GRYPE_DB_AUTO_UPDATE=false`. The
 * comparison is of matchers over fixed data, so a mid-run database change would invalidate it.
 *
 * When no GitHub advisory cache exists (the usual case without tokens), the trivy-vs-grype grid is
 * still produced in full and the github column is reported as "not run".
 */

import {execFile} from 'child_process'
import fs from 'fs'
import path from 'path'
import {promisify} from 'util'
import {
    canonicalId,
    grypeFindings,
    GrypeReport,
    packageKeys,
    trivyFindings,
    TrivyReport,
} from '../src/plugins/sbom/local-scan'
import {parsePurl} from '../src/plugins/sbom/cyclonedx'
import {readManifest} from '../src/vuln-sources/github/cache'
import {ecosystemForPurlType} from '../src/vuln-sources/github/ecosystems'
import {buildAdvisoryIndex, matchComponent} from '../src/vuln-sources/github/match'
import {readEcosystem} from '../src/vuln-sources/github/cache'

const execFileAsync = promisify(execFile)

const COMPARISON_DIR = path.resolve(process.env.DEPINDER_COMPARISON_DIR ?? '.')
const SBOM_DIR = path.join(COMPARISON_DIR, 'inputs/voyager/sboms')
const RESULTS_DIR = path.join(COMPARISON_DIR, 'results')
const CACHE_DIR = path.resolve(process.cwd(), 'cache')

const PROJECTS = [
    'c-cpp-redis',
    'dotnet-eshoponweb',
    'go-caddy',
    'java-gradle-teammates',
    'java-maven-spring-petclinic',
    'js-npm-nest',
    'js-pnpm-n8n',
    'js-yarn-excalidraw',
    'php-monica',
    'python-saleor',
    'ruby-mastodon',
    'rust-ripgrep',
]

/** `<project>.cdx.json` is Syft's; `<project>.trivy.cdx.json` is Trivy's. */
const PRODUCERS = [
    {name: 'syft', suffix: '.cdx.json'},
    {name: 'trivy', suffix: '.trivy.cdx.json'},
] as const

type SourceName = 'trivy' | 'grype' | 'github'
const SOURCES: SourceName[] = ['trivy', 'grype', 'github']

/** A finding, reduced to what the comparison compares. */
type FindingKey = string

interface CellResult {
    project: string
    producer: string
    file: string
    counts: {[source in SourceName]: number | null}
    /** null when that pair could not be compared because one side did not run. */
    overlap: {[pair: string]: number | null}
    only: {[source in SourceName]: FindingKey[]}
    error?: string
}

const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024

async function run(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string | undefined> {
    try {
        const {stdout} = await execFileAsync(bin, args, {
            maxBuffer: MAX_OUTPUT_BYTES,
            env: {...process.env, ...env},
        })
        return stdout
    } catch (e: any) {
        // Both tools exit non-zero on findings in some modes; the stdout is still the report.
        if (typeof e?.stdout === 'string' && e.stdout.trim().startsWith('{')) return e.stdout
        console.error(`  ${bin} failed: ${e?.message ?? e}`)
        return undefined
    }
}

function keysOf(findings: {packageDedupKey?: string, packageKeys: string[], ids: string[]}[]): Set<FindingKey> {
    const keys = new Set<FindingKey>()
    for (const finding of findings) {
        const id = canonicalId(finding.ids)
        if (!id) continue
        keys.add(`${finding.packageDedupKey ?? finding.packageKeys[0]}|${id.toUpperCase()}`)
    }
    return keys
}

/** The GitHub source's findings for one SBOM, in the same (package, canonical id) form. */
function githubKeys(sbomFile: string, indexes: Map<string, ReturnType<typeof buildAdvisoryIndex>>): Set<FindingKey> | undefined {
    if (indexes.size === 0) return undefined
    const bom = JSON.parse(fs.readFileSync(sbomFile, 'utf8'))
    const keys = new Set<FindingKey>()
    for (const component of bom.components ?? []) {
        if (!component.purl) continue
        const purl = parsePurl(component.purl)
        if (!purl) continue
        const ecosystem = ecosystemForPurlType(purl.type)
        if (!ecosystem) continue
        const index = indexes.get(ecosystem.name)
        if (!index) continue
        const dedupKey = packageKeys(component.purl, purl.name, purl.version).dedupKey
        for (const finding of matchComponent(index, ecosystem.name, purl.name, purl.version)) {
            const id = canonicalId((finding.identifiers ?? []).map(it => it.value))
            if (id) keys.add(`${dedupKey}|${id.toUpperCase()}`)
        }
    }
    return keys
}

function intersect(a: Set<string>, b: Set<string>): number {
    let n = 0
    for (const key of a) if (b.has(key)) n++
    return n
}

function only(a: Set<string>, others: (Set<string> | undefined)[]): string[] {
    return [...a].filter(key => others.every(other => !other || !other.has(key))).sort()
}

async function compareOne(
    project: string,
    producer: string,
    file: string,
    githubIndexes: Map<string, ReturnType<typeof buildAdvisoryIndex>>
): Promise<CellResult> {
    const [trivyJson, grypeJson] = await Promise.all([
        run('trivy', ['sbom', '--format', 'json', '--skip-db-update', '--skip-java-db-update', '--offline-scan', file]),
        run('grype', [`sbom:${file}`, '-o', 'json'], {GRYPE_DB_AUTO_UPDATE: 'false'}),
    ])

    const trivy = trivyJson ? keysOf(trivyFindings(JSON.parse(trivyJson) as TrivyReport)) : undefined
    const grype = grypeJson ? keysOf(grypeFindings(JSON.parse(grypeJson) as GrypeReport)) : undefined
    const github = githubKeys(file, githubIndexes)

    const sets: {[source in SourceName]: Set<string> | undefined} = {trivy, grype, github}
    const pair = (a: SourceName, b: SourceName): number | null =>
        sets[a] && sets[b] ? intersect(sets[a] as Set<string>, sets[b] as Set<string>) : null

    return {
        project,
        producer,
        file,
        counts: {
            trivy: trivy?.size ?? null,
            grype: grype?.size ?? null,
            github: github?.size ?? null,
        },
        overlap: {
            'trivy&grype': pair('trivy', 'grype'),
            'trivy&github': pair('trivy', 'github'),
            'grype&github': pair('grype', 'github'),
        },
        only: {
            trivy: trivy ? only(trivy, [grype, github]) : [],
            grype: grype ? only(grype, [trivy, github]) : [],
            github: github ? only(github, [trivy, grype]) : [],
        },
    }
}

function loadGithubIndexes(): Map<string, ReturnType<typeof buildAdvisoryIndex>> {
    const indexes = new Map<string, ReturnType<typeof buildAdvisoryIndex>>()
    const manifest = readManifest(CACHE_DIR)
    for (const ecosystem of Object.keys(manifest.ecosystems)) {
        try {
            indexes.set(ecosystem, buildAdvisoryIndex(readEcosystem(CACHE_DIR, ecosystem)))
        } catch (e: any) {
            console.error(`Could not index ${ecosystem}: ${e?.message ?? e}`)
        }
    }
    return indexes
}

function cell(value: number | null): string {
    return value === null ? '—' : String(value)
}

function markdown(results: CellResult[], githubEcosystems: string[]): string {
    const lines: string[] = []
    const githubRan = githubEcosystems.length > 0

    lines.push('# Vulnerability source comparison: Trivy vs Grype vs GitHub advisories')
    lines.push('')
    lines.push(`Generated ${new Date().toISOString()} by \`scripts/compare-vuln-sources.ts\` (depinder,`
        + ' branch `github-advisory-source`).')
    lines.push('')
    lines.push('Every finding is reduced to `(purl-derived name@version, canonical id)`, where the canonical id is')
    lines.push('the CVE when the source knows one and the GHSA otherwise — so GHSA and CVE views of one advisory')
    lines.push('count as one finding, not two. Neither scanner database was updated during the run.')
    lines.push('')
    if (githubRan) {
        lines.push(`GitHub advisory cache: ${githubEcosystems.join(', ')}.`)
    } else {
        lines.push('**The GitHub source did not run**: no advisory cache exists (no tokens were available to build')
        lines.push('one). Its columns read `—`. The Trivy/Grype grid below is complete.')
    }
    lines.push('')

    // The cross-SBOM grid.
    lines.push('## Findings per source, per SBOM producer')
    lines.push('')
    lines.push('| Project | Syft: trivy | Syft: grype | Syft: github | Syft: T∩G | Trivy SBOM: trivy | Trivy SBOM: grype | Trivy SBOM: github | Trivy SBOM: T∩G |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
    for (const project of PROJECTS) {
        const syft = results.find(it => it.project === project && it.producer === 'syft')
        const trivySbom = results.find(it => it.project === project && it.producer === 'trivy')
        lines.push(`| ${project} | ${cell(syft?.counts.trivy ?? null)} | ${cell(syft?.counts.grype ?? null)}`
            + ` | ${cell(syft?.counts.github ?? null)} | ${cell(syft?.overlap['trivy&grype'] ?? null)}`
            + ` | ${cell(trivySbom?.counts.trivy ?? null)} | ${cell(trivySbom?.counts.grype ?? null)}`
            + ` | ${cell(trivySbom?.counts.github ?? null)} | ${cell(trivySbom?.overlap['trivy&grype'] ?? null)} |`)
    }
    const total = (producer: string, source: SourceName): number | null => {
        const cells = results.filter(it => it.producer === producer)
        if (cells.some(it => it.counts[source] === null)) return null
        return cells.reduce((sum, it) => sum + (it.counts[source] ?? 0), 0)
    }
    const totalOverlap = (producer: string): number | null => {
        const cells = results.filter(it => it.producer === producer)
        if (cells.some(it => it.overlap['trivy&grype'] === null)) return null
        return cells.reduce((sum, it) => sum + (it.overlap['trivy&grype'] ?? 0), 0)
    }
    lines.push(`| **total** | **${cell(total('syft', 'trivy'))}** | **${cell(total('syft', 'grype'))}**`
        + ` | **${cell(total('syft', 'github'))}** | **${cell(totalOverlap('syft'))}**`
        + ` | **${cell(total('trivy', 'trivy'))}** | **${cell(total('trivy', 'grype'))}**`
        + ` | **${cell(total('trivy', 'github'))}** | **${cell(totalOverlap('trivy'))}** |`)
    lines.push('')

    // Per project detail.
    lines.push('## Per project')
    lines.push('')
    for (const project of PROJECTS) {
        lines.push(`### ${project}`)
        lines.push('')
        lines.push('| SBOM | trivy | grype | github | trivy∩grype | trivy∩github | grype∩github |')
        lines.push('|---|---:|---:|---:|---:|---:|---:|')
        for (const producer of PRODUCERS) {
            const result = results.find(it => it.project === project && it.producer === producer.name)
            if (!result) continue
            lines.push(`| ${producer.name} | ${cell(result.counts.trivy)} | ${cell(result.counts.grype)}`
                + ` | ${cell(result.counts.github)} | ${cell(result.overlap['trivy&grype'])}`
                + ` | ${cell(result.overlap['trivy&github'])} | ${cell(result.overlap['grype&github'])} |`)
        }
        lines.push('')
        for (const producer of PRODUCERS) {
            const result = results.find(it => it.project === project && it.producer === producer.name)
            if (!result) continue
            for (const source of SOURCES) {
                const unique = result.only[source]
                if (unique.length === 0) continue
                lines.push(`- **${producer.name} SBOM, ${source} only** (${unique.length}): `
                    + unique.slice(0, 25).join(', ')
                    + (unique.length > 25 ? `, … and ${unique.length - 25} more (see the JSON)` : ''))
            }
        }
        lines.push('')
    }
    return lines.join('\n')
}

async function main(): Promise<void> {
    const githubIndexes = loadGithubIndexes()
    const githubEcosystems = [...githubIndexes.keys()].sort()
    if (githubEcosystems.length === 0) {
        console.log('No GitHub advisory cache found — the github column will read "not run".')
    } else {
        console.log(`GitHub advisory cache: ${githubEcosystems.join(', ')}`)
    }

    const results: CellResult[] = []
    for (const project of PROJECTS) {
        for (const producer of PRODUCERS) {
            const file = path.join(SBOM_DIR, `${project}${producer.suffix}`)
            if (!fs.existsSync(file)) {
                console.error(`missing: ${file}`)
                continue
            }
            console.log(`${project} / ${producer.name}`)
            results.push(await compareOne(project, producer.name, file, githubIndexes))
        }
    }

    fs.mkdirSync(RESULTS_DIR, {recursive: true})
    const jsonFile = path.join(RESULTS_DIR, 'vuln-source-comparison.json')
    const markdownFile = path.join(RESULTS_DIR, 'vuln-source-comparison.md')
    fs.writeFileSync(jsonFile, JSON.stringify({
        generatedAt: new Date().toISOString(),
        githubEcosystems,
        githubRan: githubEcosystems.length > 0,
        results,
    }, null, 2))
    fs.writeFileSync(markdownFile, markdown(results, githubEcosystems))
    console.log(`Written:\n  ${markdownFile}\n  ${jsonFile}`)
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
