/**
 * Diffs a `depinder export-blackduck` run against a real Black Duck export.
 *
 * Run it with:
 *
 *     npx ts-node -T scripts/diff-blackduck-export.ts <ours> <theirs> [<label> ...]
 *
 * (`-T` transpiles without type-checking, because this file sits outside the `src` rootDir the
 * project's tsconfig declares. Defaults are the mastodon folders under the comparison repo, so it
 * can also be run with no arguments at all.)
 *
 * Method. Everything joins on `Component Version Origin Id` and on nothing else. Black Duck's
 * `Component name` is a Knowledge Base DISPLAY name — `Action Mailer` for the gem `actionmailer`,
 * `BurntSushi/regex-automata` for the crate `regex-automata` — so joining on it would score most
 * of the shared rows as disagreements about a name neither side is wrong about.
 *
 * Three known properties of the reference export, from the 2026-09-04 audit, are worth holding in
 * mind when reading the output:
 *   - 656 of Black Duck's 1,674 vulnerability rows are BDSA-only, with no CVE at all, so they can
 *     never match a finding from a CVE/GHSA source. They are counted separately below.
 *   - Black Duck's `elasticsearch-api` carries 24 Elasticsearch SERVER CVEs it should not.
 *   - The export covers a Black Duck project whose scan is not the SBOM we are given, so a large
 *     only-in-BD set is expected and is not by itself evidence of a gap in depinder.
 */

import fs from 'fs'
import path from 'path'

const DEFAULT_OURS = [
    {label: 'trivy', dir: '/Users/alex/Work/Endava/BD-trivy-syft-comparison/exports/ruby-mastodon-trivy'},
    {label: 'syft', dir: '/Users/alex/Work/Endava/BD-trivy-syft-comparison/exports/ruby-mastodon-syft'},
]
const DEFAULT_THEIRS = '/Users/alex/Work/Endava/BD-trivy-syft-comparison/inputs/blackduck/ruby-mastodon/export'
const DEFAULT_OUTPUT = '/Users/alex/Work/Endava/BD-trivy-syft-comparison/results/blackduck-export-diff.md'

// ---------------------------------------------------------------------------
// A minimal RFC 4180 reader. Quoted cells hold commas and newlines; `""` is one quote.
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let row: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quoted) {
            if (c === '"') {
                if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
            } else cell += c
            continue
        }
        if (c === '"') quoted = true
        else if (c === ',') { row.push(cell); cell = '' }
        else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
        else if (c !== '\r') cell += c
    }
    if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
    return rows
}

type Record = {[column: string]: string}

function readCsv(file: string): Record[] {
    const rows = parseCsv(fs.readFileSync(file, 'utf8'))
    if (rows.length === 0) return []
    const headers = rows[0]
    return rows.slice(1)
        .filter(it => it.some(cell => cell.length > 0))
        .map(it => Object.fromEntries(headers.map((h, i) => [h, (it[i] ?? '').trim()])))
}

/** Black Duck's only file in the export folder with a timestamped name we have to glob for. */
function findFile(dir: string, exact: string, prefix?: string): string | undefined {
    const direct = path.join(dir, exact)
    if (fs.existsSync(direct)) return direct
    if (!prefix) return undefined
    const match = fs.readdirSync(dir).find(it => it.startsWith(prefix) && it.endsWith('.csv'))
    return match ? path.join(dir, match) : undefined
}

// ---------------------------------------------------------------------------
// The comparisons
// ---------------------------------------------------------------------------

const KEY = 'Component Version Origin Id'

interface SetDiff {
    shared: string[]
    onlyOurs: string[]
    onlyTheirs: string[]
}

function diffKeys(ours: Set<string>, theirs: Set<string>): SetDiff {
    return {
        shared: [...ours].filter(it => theirs.has(it)).sort(),
        onlyOurs: [...ours].filter(it => !theirs.has(it)).sort(),
        onlyTheirs: [...theirs].filter(it => !ours.has(it)).sort(),
    }
}

/** The CVE a Black Duck vulnerability id carries, if any: `BDSA-2026-15106 (CVE-2026-50171)`. */
function cveOf(vulnerabilityId: string): string | undefined {
    const match = /\bCVE-\d{4}-\d+\b/i.exec(vulnerabilityId)
    return match ? match[0].toUpperCase() : undefined
}

interface Agreement {
    column: string
    compared: number
    agreed: number
    examples: string[]
}

function agreement(
    column: string,
    shared: string[],
    ours: Map<string, Record>,
    theirs: Map<string, Record>,
    normalize: (value: string) => string = it => it
): Agreement {
    let compared = 0
    let agreed = 0
    const examples: string[] = []
    for (const key of shared) {
        const a = normalize(ours.get(key)?.[column] ?? '')
        const b = normalize(theirs.get(key)?.[column] ?? '')
        compared++
        if (a === b) agreed++
        else if (examples.length < 8) examples.push(`\`${key}\`: ours \`${a || '(empty)'}\` vs BD \`${b || '(empty)'}\``)
    }
    return {column, compared, agreed, examples}
}

function percent(agreed: number, compared: number): string {
    return compared === 0 ? '—' : `${((agreed / compared) * 100).toFixed(1)}%`
}

function byKey(records: Record[], key: string = KEY): Map<string, Record> {
    const map = new Map<string, Record>()
    for (const record of records) {
        const id = record[key]
        if (id && !map.has(id)) map.set(id, record)
    }
    return map
}

function section(title: string, lines: string[]): string[] {
    return ['', title, '', ...lines]
}

function sample(keys: string[], n = 12): string {
    if (keys.length === 0) return '_(none)_'
    return keys.slice(0, n).map(it => `\`${it}\``).join(', ')
        + (keys.length > n ? `, … and ${keys.length - n} more` : '')
}

function compareDependencies(oursDir: string, theirsDir: string): string[] {
    const oursFile = findFile(oursDir, '_dependencies.csv')
    const theirsFile = findFile(theirsDir, '_dependencies.csv')
    if (!oursFile || !theirsFile) return ['_`_dependencies.csv` missing on one side._']

    const ours = byKey(readCsv(oursFile))
    const theirs = byKey(readCsv(theirsFile))
    const diff = diffKeys(new Set(ours.keys()), new Set(theirs.keys()))

    // Black Duck writes the licence display name; both sides are compared verbatim, because the
    // export maps SPDX ids to those same names on purpose.
    const agreements = [
        agreement('Match type', diff.shared, ours, theirs),
        agreement('License names', diff.shared, ours, theirs),
        agreement('Total Vulnerability Count', diff.shared, ours, theirs, it => it || '0'),
    ]

    return [
        `- rows: ours **${ours.size}**, Black Duck **${theirs.size}**`,
        `- shared origin ids: **${diff.shared.length}**`,
        `- only ours: **${diff.onlyOurs.length}** — ${sample(diff.onlyOurs)}`,
        `- only Black Duck: **${diff.onlyTheirs.length}** — ${sample(diff.onlyTheirs)}`,
        '',
        '| Column | Compared | Agreed | Agreement |',
        '|---|---:|---:|---:|',
        ...agreements.map(it => `| ${it.column} | ${it.compared} | ${it.agreed} | ${percent(it.agreed, it.compared)} |`),
        '',
        ...agreements.flatMap(it => it.examples.length === 0 ? [] : [
            `Disagreements on **${it.column}** (first ${it.examples.length}):`,
            ...it.examples.map(e => `- ${e}`),
            '',
        ]),
    ]
}

function compareVulnerabilities(oursDir: string, theirsDir: string): string[] {
    const oursFile = findFile(oursDir, '_vulnerability_details.csv')
    const theirsFile = findFile(theirsDir, '_vulnerability_details.csv')
    if (!oursFile || !theirsFile) return ['_`_vulnerability_details.csv` missing on one side._']

    const oursRows = readCsv(oursFile)
    const theirsRows = readCsv(theirsFile)

    // Component level: which components either side reports as vulnerable at all.
    const oursComponents = new Set(oursRows.map(it => it[KEY]).filter(Boolean))
    const theirsComponents = new Set(theirsRows.map(it => it[KEY]).filter(Boolean))
    const componentDiff = diffKeys(oursComponents, theirsComponents)

    // Finding level: (component, CVE). Black Duck rows with no CVE at all cannot be matched by
    // any CVE/GHSA source, so they are reported separately rather than counted as misses.
    const oursFindings = new Set<string>()
    for (const row of oursRows) {
        const cve = cveOf(row['Vulnerability id'] ?? '')
        if (cve) oursFindings.add(`${row[KEY]}|${cve}`)
    }
    const theirsFindings = new Set<string>()
    let bdsaOnly = 0
    for (const row of theirsRows) {
        const cve = cveOf(row['Vulnerability id'] ?? '')
        if (cve) theirsFindings.add(`${row[KEY]}|${cve}`)
        else bdsaOnly++
    }
    const findingDiff = diffKeys(oursFindings, theirsFindings)

    // Restricted to components both sides know about, the finding comparison is fair: a component
    // Black Duck never scanned cannot disagree about its advisories.
    const inBoth = (key: string) => componentDiff.shared.includes(key.split('|')[0])
    const sharedComponentFindings = {
        ours: [...oursFindings].filter(inBoth),
        theirs: [...theirsFindings].filter(inBoth),
    }
    const restricted = diffKeys(new Set(sharedComponentFindings.ours), new Set(sharedComponentFindings.theirs))

    return [
        `- rows: ours **${oursRows.length}**, Black Duck **${theirsRows.length}** (of which **${bdsaOnly}** carry no CVE and can never match a CVE/GHSA source)`,
        '',
        '**Vulnerable components** (by origin id)',
        '',
        `- shared: **${componentDiff.shared.length}**`,
        `- only ours: **${componentDiff.onlyOurs.length}** — ${sample(componentDiff.onlyOurs)}`,
        `- only Black Duck: **${componentDiff.onlyTheirs.length}** — ${sample(componentDiff.onlyTheirs)}`,
        '',
        '**Findings** (by origin id + CVE)',
        '',
        `- shared: **${findingDiff.shared.length}**`,
        `- only ours: **${findingDiff.onlyOurs.length}**`,
        `- only Black Duck: **${findingDiff.onlyTheirs.length}**`,
        '',
        '**Findings, restricted to components both sides report as vulnerable**',
        '',
        `- shared: **${restricted.shared.length}** (${percent(restricted.shared.length, sharedComponentFindings.theirs.length)} of Black Duck's)`,
        `- only ours: **${restricted.onlyOurs.length}** — ${sample(restricted.onlyOurs, 15)}`,
        `- only Black Duck: **${restricted.onlyTheirs.length}** — ${sample(restricted.onlyTheirs, 15)}`,
    ]
}

function main(): void {
    const args = process.argv.slice(2)
    const runs = args.length >= 2
        ? [{label: path.basename(args[0]), dir: args[0]}]
        : DEFAULT_OURS.filter(it => fs.existsSync(it.dir))
    const theirsDir = args.length >= 2 ? args[1] : DEFAULT_THEIRS

    const lines: string[] = [
        '# Black Duck export diff: depinder `export-blackduck` vs a real Black Duck export',
        '',
        `Generated ${new Date().toISOString()} by \`scripts/diff-blackduck-export.ts\` (depinder).`,
        '',
        `Black Duck export: \`${theirsDir}\``,
        '',
        'Everything joins on `Component Version Origin Id`. Black Duck\'s `Component name` is a',
        'Knowledge Base display name (`Action Mailer` for the gem `actionmailer`), so it is not a',
        'join key and no agreement is computed for it.',
    ]

    for (const run of runs) {
        lines.push(...section(`## ${run.label} SBOM`, [`Our export: \`${run.dir}\``]))
        lines.push(...section('### `_dependencies.csv`', compareDependencies(run.dir, theirsDir)))
        lines.push(...section('### `_vulnerability_details.csv`', compareVulnerabilities(run.dir, theirsDir)))
    }

    const output = args.length >= 3 ? args[2] : DEFAULT_OUTPUT
    fs.mkdirSync(path.dirname(output), {recursive: true})
    fs.writeFileSync(output, lines.join('\n') + '\n')
    console.log(`Written: ${output}`)
}

main()
