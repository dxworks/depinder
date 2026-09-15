/**
 * SPDX licence identifiers to the two columns Black Duck reports: a display name and a family.
 *
 * Registries give us SPDX ids (`MIT`, `Apache-2.0`); Black Duck's export gives display names
 * (`MIT License`, `Apache License 2.0`) and a family from a closed vocabulary. The two columns are
 * the same fact twice, so one table fills both. The names are copied verbatim from the reference
 * export so a diff can compare the cells directly rather than through a normaliser.
 *
 * The table is deliberately short: it covers the licences that actually occur, and everything else
 * falls through to the SPDX id itself with family `UNKNOWN`. That fails visibly — an unmapped
 * licence shows up as an id next to a name in the diff — rather than silently claiming a family.
 */

/** Black Duck's licence-family vocabulary, as observed in the reference export. */
export type LicenseFamily = 'PERMISSIVE' | 'WEAK_RECIPROCAL' | 'RECIPROCAL' | 'RESTRICTED_PROPRIETARY' | 'UNKNOWN'

interface KnownLicense {
    name: string
    family: LicenseFamily
}

const LICENSES: {readonly [spdxId: string]: KnownLicense} = {
    'MIT': {name: 'MIT License', family: 'PERMISSIVE'},
    // Black Duck collapses MIT-0 into "MIT License"; keeping the distinct SPDX name here means
    // the licence column disagrees with theirs on purpose, and the family column agrees.
    'MIT-0': {name: 'MIT No Attribution', family: 'PERMISSIVE'},
    'Apache-2.0': {name: 'Apache License 2.0', family: 'PERMISSIVE'},
    'ISC': {name: 'ISC License', family: 'PERMISSIVE'},
    'BSD-3-Clause': {name: 'BSD 3-clause "New" or "Revised" License', family: 'PERMISSIVE'},
    'BSD-2-Clause': {name: 'BSD 2-clause "Simplified" License', family: 'PERMISSIVE'},
    'BSD-4-Clause': {name: 'BSD 4-clause "Original" or "Old" License', family: 'PERMISSIVE'},
    '0BSD': {name: 'BSD Zero Clause License', family: 'PERMISSIVE'},
    'Unlicense': {name: 'The Unlicense', family: 'PERMISSIVE'},
    'CC0-1.0': {name: 'Creative Commons Zero v1.0 Universal', family: 'PERMISSIVE'},
    'BlueOak-1.0.0': {name: 'Blue Oak Model License 1.0.0', family: 'PERMISSIVE'},
    'Zlib': {name: 'zlib License', family: 'PERMISSIVE'},
    'PSF-2.0': {name: 'Python Software Foundation License 2.0', family: 'PERMISSIVE'},
    'Python-2.0': {name: 'Python License 2.0', family: 'PERMISSIVE'},
    // Weak copyleft, not permissive: the Ruby licence offers the GPL as its alternative branch.
    // Black Duck's own export agrees -- `Ruby License` alone is WEAK_RECIPROCAL there, risk MEDIUM.
    'Ruby': {name: 'Ruby License', family: 'WEAK_RECIPROCAL'},
    'PostgreSQL': {name: 'PostgreSQL License', family: 'PERMISSIVE'},
    'WTFPL': {name: 'Do What The F*ck You Want To Public License', family: 'PERMISSIVE'},
    'Artistic-2.0': {name: 'Artistic License 2.0', family: 'PERMISSIVE'},
    'MPL-2.0': {name: 'Mozilla Public License 2.0', family: 'WEAK_RECIPROCAL'},
    'EPL-1.0': {name: 'Eclipse Public License 1.0', family: 'WEAK_RECIPROCAL'},
    'EPL-2.0': {name: 'Eclipse Public License 2.0', family: 'WEAK_RECIPROCAL'},
    'LGPL-2.1': {name: 'GNU Lesser General Public License v2.1', family: 'WEAK_RECIPROCAL'},
    'LGPL-2.1-only': {name: 'GNU Lesser General Public License v2.1 only', family: 'WEAK_RECIPROCAL'},
    'LGPL-2.1-or-later': {name: 'GNU Lesser General Public License v2.1 or later', family: 'WEAK_RECIPROCAL'},
    'LGPL-3.0': {name: 'GNU Lesser General Public License v3.0', family: 'WEAK_RECIPROCAL'},
    'CDDL-1.0': {name: 'Common Development and Distribution License 1.0', family: 'WEAK_RECIPROCAL'},
    'CDDL-1.1': {name: 'Common Development and Distribution License 1.1', family: 'WEAK_RECIPROCAL'},
    'GPL-2.0': {name: 'GNU General Public License v2.0', family: 'RECIPROCAL'},
    'GPL-3.0': {name: 'GNU General Public License v3.0', family: 'RECIPROCAL'},
    'AGPL-3.0': {name: 'GNU Affero General Public License v3.0', family: 'RECIPROCAL'},
    'AGPL-3.0-only': {name: 'GNU Affero General Public License v3.0 only', family: 'RECIPROCAL'},
    'GPL-2.0-only': {name: 'GNU General Public License v2.0 only', family: 'RECIPROCAL'},
    'GPL-2.0-or-later': {name: 'GNU General Public License v2.0 or later', family: 'RECIPROCAL'},
    'GPL-3.0-or-later': {name: 'GNU General Public License v3.0 or later', family: 'RECIPROCAL'},
    'CC-BY-3.0': {name: 'Creative Commons Attribution 3.0', family: 'PERMISSIVE'},
    'CC-BY-4.0': {name: 'Creative Commons Attribution 4.0', family: 'PERMISSIVE'},
    'W3C': {name: 'W3C Software Notice and License', family: 'PERMISSIVE'},
    // Below: names the reference export writes that the table above did not have. The family is
    // the one Black Duck itself reports -- read off its single-licence rows, or, for a name that
    // only ever appears inside an expression, deduced from the one family in the cell that the
    // other operands do not account for.
    'LGPL-3.0-only': {name: 'GNU Lesser General Public License v3.0 only', family: 'WEAK_RECIPROCAL'},
    'LGPL-3.0-or-later': {name: 'GNU Lesser General Public License v3.0 or later', family: 'WEAK_RECIPROCAL'},
    'GPL-3.0-only': {name: 'GNU General Public License v3.0 only', family: 'RECIPROCAL'},
    'GPL-2.0-with-classpath-exception': {
        name: 'GNU General Public License v2.0 w/Classpath exception', family: 'RECIPROCAL',
    },
    'Classpath-exception-2.0': {
        name: 'GNU General Public License v2.0 w/Classpath exception', family: 'RECIPROCAL',
    },
    // Eclipse's BSD-3-Clause variant. Black Duck keeps it as its own name, and calls it PERMISSIVE.
    'EDL-1.0': {name: 'Eclipse Distribution License - v 1.0', family: 'PERMISSIVE'},
    'OFL-1.1': {name: 'SIL Open Font License 1.1', family: 'WEAK_RECIPROCAL'},
    'UPL-1.0': {name: 'Universal Permissive License v1.0', family: 'PERMISSIVE'},
    'NCSA': {name: 'University of Illinois/NCSA Open Source License', family: 'PERMISSIVE'},
    'AFL-2.1': {name: 'Academic Free License v2.1', family: 'PERMISSIVE'},
    'MPL-1.1': {name: 'Mozilla Public License 1.1', family: 'WEAK_RECIPROCAL'},
    'Artistic-1.0': {name: 'Artistic License 1.0', family: 'WEAK_RECIPROCAL'},
    'Artistic-1.0-Perl': {name: 'Artistic License 1.0 (Perl)', family: 'WEAK_RECIPROCAL'},
    'BSD-2-Clause-Views': {name: 'BSD 2-Clause with views sentence', family: 'PERMISSIVE'},
    'Unicode-3.0': {name: 'Unicode License v3', family: 'PERMISSIVE'},
    'Unicode-DFS-2016': {
        name: 'Unicode License Agreement - Data Files and Software (2016)', family: 'PERMISSIVE',
    },
    'Universal-FOSS-exception-1.0': {name: 'Universal FOSS Exception, Version 1.0', family: 'WEAK_RECIPROCAL'},
    'MIT-CMU': {name: 'CMU License', family: 'PERMISSIVE'},
    // Black Duck keeps Expat distinct from MIT. They are the same licence text; it is their
    // vocabulary, so it is reproduced rather than collapsed.
    'MIT-Expat': {name: 'Expat License', family: 'PERMISSIVE'},
    'Public-Domain': {name: 'Public Domain', family: 'PERMISSIVE'},
    'MS-NET-Library': {name: 'Microsoft .NET Library License', family: 'RESTRICTED_PROPRIETARY'},
}

/** Black Duck's own wording for a component whose licence it could not determine. */
const UNKNOWN: KnownLicense = {name: 'Unknown License', family: 'UNKNOWN'}

/**
 * Black Duck's `License Risk` column, which has three values in the reference export
 * (`OK` 8,233, `MEDIUM` 109, `HIGH` 39) and is a function of the licence family.
 *
 * `UNKNOWN` is a fourth value, ours, and it is a deliberate divergence. Black Duck answers every
 * row: a licence it cannot determine is `Unknown License` at `HIGH`, because inside its own
 * Knowledge Base not finding a licence really is evidence. We have no Knowledge Base, so the same
 * `HIGH` would be claiming a risk assessment we did not make -- and it was the single biggest
 * source of disagreement: 665 of the 731 rows whose risk differed were us saying `HIGH` where
 * Black Duck said `OK`. `UNKNOWN` says the honest thing instead, and keeps those rows findable.
 */
type KnownRisk = 'OK' | 'MEDIUM' | 'HIGH'
export type LicenseRisk = KnownRisk | 'UNKNOWN'

/** Measured against the reference export: every single-licence component follows this table. */
const FAMILY_RISK: {readonly [family in Exclude<LicenseFamily, 'UNKNOWN'>]: KnownRisk} = {
    PERMISSIVE: 'OK',
    WEAK_RECIPROCAL: 'MEDIUM',
    RESTRICTED_PROPRIETARY: 'MEDIUM',
    RECIPROCAL: 'HIGH',
}

const RISK_ORDER: KnownRisk[] = ['OK', 'MEDIUM', 'HIGH']
const worst = (risks: KnownRisk[]): KnownRisk =>
    risks.reduce((a, b) => (RISK_ORDER.indexOf(b) > RISK_ORDER.indexOf(a) ? b : a), 'OK')
const best = (risks: KnownRisk[]): KnownRisk =>
    risks.reduce((a, b) => (RISK_ORDER.indexOf(b) < RISK_ORDER.indexOf(a) ? b : a), 'HIGH')

/**
 * An unreadable operand only spoils the answer when it could still change it.
 *
 * A conjunction carries every obligation, so the risk is the highest one -- and an operand we
 * cannot read can only be that high or lower. If the licences we DID read already reach `HIGH`,
 * the unreadable one cannot make it worse and the answer stands; below `HIGH` it could, so the
 * answer is `UNKNOWN`.
 */
const conjunction = (known: KnownRisk[], unreadable: boolean): LicenseRisk => {
    if (known.length === 0) return 'UNKNOWN'
    const risk = worst(known)
    return unreadable && risk !== 'HIGH' ? 'UNKNOWN' : risk
}

/**
 * The mirror image: a choice lets you take the most permissive branch, so an unreadable branch
 * only matters when the branches we read are not already as permissive as it gets.
 */
const choice = (known: KnownRisk[], unreadable: boolean): LicenseRisk => {
    if (known.length === 0) return 'UNKNOWN'
    const risk = best(known)
    return unreadable && risk !== 'OK' ? 'UNKNOWN' : risk
}


// --------------------------------------------------------------------------
// Reading a licence string
// --------------------------------------------------------------------------
// Everything below reads ONE vocabulary: whatever a registry, an SBOM or a finished export
// happens to hold. `Apache-2.0`, `Apache License 2.0`, `Apache License, Version 2.0`, `The Apache
// Software License, Version 2.0` and `Apache 2` are the same licence written five ways, and only
// the first two used to be readable -- everything else was copied into the CSV verbatim and
// counted as UNKNOWN, which then reported the component at HIGH risk. Measured against the
// reference export, that mislabelled 321 components whose licence we were in fact holding.
//
// The rules are deliberately conservative. A string that cannot be resolved to an entry in the
// table stays unresolved and the risk becomes `UNKNOWN` -- guessing a licence is worse than
// admitting we cannot read one.

/** An operand of a licence expression. `id` is empty when the text names no licence we can read. */
interface Operand {
    id: string
    name: string
    family: LicenseFamily
}

/**
 * The order Black Duck writes multiple licences in.
 *
 * Black Duck does not keep the order the manifest declared: `Unlicense OR MIT` comes back as
 * `(MIT License OR The Unlicense)`, and a gemspec's `["Ruby", "BSD-2-Clause"]` as `(BSD 2-clause
 * "Simplified" License OR Ruby License)`. The 167 expressions in the reference export imply 61
 * ordered pairs and not one contradiction, so there is a single order behind them; this is that
 * order, topologically sorted out of those pairs. A name the export never paired keeps its place.
 */
const BD_ORDER: string[] = [
    'GNU General Public License v2.0 w/Classpath exception',
    'Eclipse Distribution License - v 1.0',
    'Common Development and Distribution License 1.1',
    'BSD Zero Clause License',
    'GNU Lesser General Public License v2.1 only',
    'ISC License',
    'Mozilla Public License 1.1',
    'GNU Lesser General Public License v2.1 or later',
    'Python Software Foundation License 2.0',
    'Unicode License v3',
    'Universal FOSS Exception, Version 1.0',
    'Universal Permissive License v1.0',
    'University of Illinois/NCSA Open Source License',
    'zlib License',
    'MIT License',
    'BSD 2-clause "Simplified" License',
    'Apache License 2.0',
    'Ruby License',
    'The Unlicense',
    'Eclipse Public License 2.0',
    'Creative Commons Zero v1.0 Universal',
    'Do What The F*ck You Want To Public License',
    'GNU General Public License v3.0 only',
    'BSD 3-clause "New" or "Revised" License',
    'Mozilla Public License 2.0',
    'GNU General Public License v2.0 only',
    'Eclipse Public License 1.0',
    'GNU General Public License v2.0 or later',
    'SIL Open Font License 1.1',
    'Creative Commons Attribution 4.0',
    'Academic Free License v2.1',
    'Artistic License 1.0 (Perl)',
    'BSD 2-Clause with views sentence',
    'Creative Commons Attribution 3.0',
    'Public Domain',
]

/**
 * Spellings that no amount of normalising reaches: a short name with no version (`BSD` -- Black
 * Duck reads it as BSD-3-Clause), a run-together one (`LGPLv3`), a classifier, an old crates.io
 * shorthand. Every entry here occurs in the run being compared; this is not a general SPDX table.
 */
const ALIASES: {readonly [slug: string]: string} = {
    'bsd': 'BSD-3-Clause',
    'new bsd': 'BSD-3-Clause',
    'bsd 3 clause': 'BSD-3-Clause',
    '3 clause bsd': 'BSD-3-Clause',
    'bsd 2 clause': 'BSD-2-Clause',
    'apache2': 'Apache-2.0',
    'asl 2.0': 'Apache-2.0',
    'lgplv3': 'LGPL-3.0',
    'lgplv2.1': 'LGPL-2.1',
    'gplv3': 'GPL-3.0',
    'gplv2': 'GPL-2.0',
    'psf': 'PSF-2.0',
    'python': 'Python-2.0',
    'openfont 1.1': 'OFL-1.1',
    'ofl 1.1': 'OFL-1.1',
    'w3c 20150513': 'W3C',
    'expat': 'MIT-Expat',
    'unicode dfs 2016': 'Unicode-DFS-2016',
    // SPDX's `WITH` names a licence plus an exception; Black Duck writes the pair as one name.
    'gpl 2.0 with classpath exception': 'GPL-2.0-with-classpath-exception',
    'gpl 2.0 only with classpath exception': 'GPL-2.0-with-classpath-exception',
    'gpl 2.0 with classpath exception 2.0': 'GPL-2.0-with-classpath-exception',
    'gpl 2.0 only with classpath exception 2.0': 'GPL-2.0-with-classpath-exception',
    'zlib libpng': 'Zlib',
}

/** Words that carry no identity: every licence name would be the same without them. */
const NOISE = /\b(the|a|an|licen[cs]e[sd]?|software|version|v)\b/g

/**
 * A licence name reduced to what identifies it.
 *
 * `Apache License, Version 2.0`, `The Apache Software License, Version 2.0`, `Apache-2.0` and
 * `Apache 2` all reduce to `apache 2.0`, which is what makes one table serve every source.
 */
function slug(text: string): string {
    const withoutClassifier = text.includes('::') ? text.split('::').pop() ?? text : text
    const words = withoutClassifier
        .toLowerCase()
        .replace(/["'()]/g, ' ')
        .replace(/[-_/,.]+/g, m => (m === '.' ? '.' : ' '))
        .replace(/\bv(?=\d)/g, ' ')
        .replace(NOISE, ' ')
        .split(/\s+/)
        .filter(it => it.length > 0)
        // `The MIT License (MIT)` says it twice; so does `Ruby License (Ruby)`.
        .filter((it, index, all) => all.indexOf(it) === index)
    // A bare major version is the same release as `.0`: `Apache 2` is `Apache 2.0`.
    return words.map(it => (/^\d+$/.test(it) ? `${it}.0` : it)).join(' ')
}

const BY_SLUG: {[slug: string]: string} = (() => {
    const index: {[slug: string]: string} = {}
    for (const [id, license] of Object.entries(LICENSES)) {
        // The id wins over the display name when both reduce to the same slug, and an entry
        // already claimed is never overwritten -- two ids sharing a name must keep the first.
        for (const spelling of [id, license.name]) {
            const key = slug(spelling)
            if (key && !(key in index)) index[key] = id
        }
    }
    return index
})()

/**
 * The SPDX id a piece of text names, or `''` when it names none we can read.
 *
 * The text can be an id, one of Black Duck's display names, a registry's wording, or something
 * that is not a licence name at all -- nuget in particular writes `MIT https://www.nuget.org/...`
 * (an expression followed by the licence FILE), a bare URL, or, in one package, the entire licence
 * text pasted into the field.
 */
export function canonicalId(raw: string): string {
    let text = stripOuterParens(raw.trim()).replace(/\+$/, '').trim()
    if (!text) return ''

    const url = text.search(/https?:\/\//i)
    // A URL alone points at a licence file we do not fetch, so it names nothing readable; a URL
    // AFTER a name is nuget's `<expression> <licence file>`, and the name in front is the answer.
    if (url === 0) return ''
    if (url > 0) text = text.slice(0, url).trim()
    // Not a name any more: some packages put the whole licence text in the field.
    if (text.length > MAX_NAME_LENGTH) return ''

    const exact = Object.keys(LICENSES).find(it => it.toLowerCase() === text.toLowerCase())
    if (exact) return exact
    const key = slug(text)
    return BY_SLUG[key] ?? ALIASES[key] ?? ''
}

/** The longest licence NAME in the reference export is 57 characters; past this it is prose. */
const MAX_NAME_LENGTH = 90

function stripOuterParens(text: string): string {
    let current = text.trim()
    while (current.startsWith('(') && current.endsWith(')')) {
        let depth = 0
        let wraps = true
        for (let i = 0; i < current.length; i++) {
            if (current[i] === '(') depth++
            if (current[i] === ')') depth--
            if (depth === 0 && i < current.length - 1) {
                wraps = false
                break
            }
        }
        if (!wraps) break
        current = current.slice(1, -1).trim()
    }
    return current
}

/**
 * One licence expression, parsed.
 *
 * The operators are read case-sensitively, as SPDX writes them. That matters: `GNU Lesser General
 * Public License v2.1 or later` is ONE name containing the word "or", and splitting it on a
 * case-insensitive `or` used to produce the operand `later`. A name is therefore tried whole
 * before it is treated as an expression at all.
 */
function parseExpression(expression: string): {operands: Operand[], isChoice: boolean} {
    const text = stripOuterParens(expression.trim())

    const whole = canonicalId(text)
    if (whole) return {operands: [operandOf(whole, text)], isChoice: false}

    // `MIT/Apache-2.0` and `Unlicense/MIT`: crates.io's pre-SPDX shorthand for a choice.
    const slashed = text.split('/')
    if (slashed.length > 1 && slashed.every(it => canonicalId(it))) {
        return {operands: slashed.map(it => operandOf(canonicalId(it), it)), isChoice: true}
    }

    const split = splitOnOperators(text, /\s+(AND|OR)\s+/)
    // Registries do write `gpl-3.0 or mit`. A lower-case split is only trusted when every operand
    // it produces is a licence we can read -- otherwise it is the "or" inside a name, and the
    // case-sensitive reading stands.
    const lower = split.operands.some(it => !it.id)
        ? splitOnOperators(text, /\s+(and|or|AND|OR)\s+/)
        : split
    return lower.operands.every(it => it.id) ? lower : split
}

function splitOnOperators(text: string, pattern: RegExp): {operands: Operand[], isChoice: boolean} {
    const parts = text.split(pattern)
    const operators = parts.filter((_, index) => index % 2 === 1).map(it => it.toUpperCase())
    const operands = parts
        .filter((_, index) => index % 2 === 0)
        .map(it => operandOf(canonicalId(it), it))
    return {operands, isChoice: operators.length > 0 && operators.every(it => it === 'OR')}
}

function operandOf(id: string, raw: string): Operand {
    const known = LICENSES[id]
    if (known) return {id, name: known.name, family: known.family}
    return {id: '', name: stripOuterParens(raw.trim()), family: 'UNKNOWN'}
}

/** The risk of the operands we could read, with the ones we could not taken into account. */
function riskOf(parsed: {operands: Operand[], isChoice: boolean}): LicenseRisk {
    const readable = parsed.operands.filter(it => it.id)
    const risks = readable.map(it => FAMILY_RISK[it.family as Exclude<LicenseFamily, 'UNKNOWN'>])
    const unreadable = parsed.operands.length !== readable.length
    return parsed.isChoice ? choice(risks, unreadable) : conjunction(risks, unreadable)
}

/**
 * The risk of one component's licences.
 *
 * The operator decides, and the reference export proves it: `(BSD 2-clause "Simplified" License OR
 * Ruby License)` is `OK` and `(BSD 2-clause "Simplified" License AND Ruby License)` is `MEDIUM` --
 * the same two licences, read two ways. `OR` is a choice, so you pick the most permissive branch
 * and the risk is the LOWEST of them; `AND` is a conjunction, so you carry every obligation and the
 * risk is the HIGHEST.
 *
 * `License families` cannot answer this: it flattens the expression to a comma-joined set and
 * drops the operator, which is why this reads the licences themselves.
 *
 * A mixed expression (`A OR B AND C`) is read as a conjunction. Precedence is not modelled, and
 * over-reporting risk is the safe direction to be wrong in.
 */
export function licenseRisk(licenses: string[]): LicenseRisk {
    return riskOfMany(licenses)
}

/**
 * The same rule, read off a `License names` cell that has already been written.
 *
 * `licenseRisk` works on whatever the registries gave us; anything reading a finished export has
 * only the rendered cell -- `(MIT License OR Mozilla Public License 2.0)`. Both go through the
 * same reader, because it resolves Black Duck's display names as readily as SPDX ids.
 */
export function licenseRiskFromNames(names: string): LicenseRisk {
    return riskOfMany(splitTopLevel(names))
}

/** Several licences side by side are a conjunction -- see `licenseColumns` for why. */
function riskOfMany(licenses: string[]): LicenseRisk {
    const present = licenses.map(it => it.trim()).filter(it => it.length > 0)
    if (present.length === 0) return 'UNKNOWN'
    const risks = present.map(it => riskOf(parseExpression(it)))
    const readable = risks.filter(it => it !== 'UNKNOWN') as KnownRisk[]
    return conjunction(readable, readable.length !== risks.length)
}

function splitTopLevel(cell: string): string[] {
    const parts: string[] = []
    let depth = 0
    let current = ''
    for (const ch of cell) {
        if (ch === '(') depth++
        if (ch === ')') depth--
        if (ch === ',' && depth === 0) {
            parts.push(current)
            current = ''
            continue
        }
        current += ch
    }
    parts.push(current)
    return parts.map(it => it.trim()).filter(it => it.length > 0)
}

/**
 * The licence columns for one component.
 *
 * A component can carry several licences, and an SPDX expression (`MIT OR Apache-2.0`) is one
 * cell holding several too. Black Duck writes an expression as `(MIT License OR Apache License
 * 2.0)` and a genuine multi-licence component as a comma-joined list, with the families joined
 * the same way and de-duplicated — so both are reproduced here rather than flattened to one name.
 *
 * Duplicates collapse. nuget repeats one licence once per manifest that declared it, so a
 * component arrives holding `MIT https://.../a/license`, `MIT https://.../b/license`, ... and the
 * cell would otherwise be that list rather than `MIT License`.
 */
export function licenseColumns(licenses: string[]): {names: string, families: string} {
    const present = licenses.map(it => it.trim()).filter(it => it.length > 0)
    if (present.length === 0) return {names: UNKNOWN.name, families: UNKNOWN.family}

    const names: string[] = []
    const families: string[] = []
    for (const license of present) {
        const {name, family} = describeExpression(license)
        if (!names.includes(name)) names.push(name)
        for (const it of family) if (!families.includes(it)) families.push(it)
    }
    // Unreadable text alongside a licence we did read says nothing the readable one does not.
    const readable = names.filter(it => it !== UNKNOWN.name)
    if (readable.length > 0 && readable.length < names.length) {
        return {names: readable.join(','), families: families.filter(it => it !== 'UNKNOWN').join(',')}
    }
    return {names: names.join(','), families: families.join(',')}
}

/**
 * The same columns, rebuilt from a cell this exporter already wrote.
 *
 * The offline recompute has no SBOM and no cache entry for every component, so for those the only
 * licence it holds is the one already in the file. That is not a dead end: the reader resolves
 * Black Duck's display names and a registry's raw wording alike, so a cell can be put back through
 * it and come out canonical -- which is exactly what the exporter would have written.
 */
export function licenseColumnsFromNames(names: string): {names: string, families: string} {
    const cell = names.trim()
    // Whole before parts, for the same reason an expression is: a licence NAME can contain a
    // comma -- `Apache License, Version 2.0` is one licence, and splitting it yields two halves
    // that name nothing.
    if (cell && canonicalId(cell)) return licenseColumns([cell])
    return licenseColumns(splitTopLevel(cell))
}

/** Maps each operand of an expression and rebuilds it in Black Duck's shape and order. */
function describeExpression(expression: string): {name: string, family: LicenseFamily[]} {
    const {operands, isChoice} = parseExpression(expression)
    const readable = operands.filter(it => it.id)
    // Nothing in it we can read: keep the text, unless it is not a name at all, in which case
    // saying `Unknown License` is both shorter and truer than pasting a URL or a licence file.
    if (readable.length === 0) {
        const text = stripOuterParens(expression.trim())
        const usable = text.length > 0 && text.length <= MAX_NAME_LENGTH && !/https?:\/\//i.test(text)
        return {name: usable ? text : UNKNOWN.name, family: ['UNKNOWN']}
    }

    const unique: Operand[] = []
    for (const operand of readable) if (!unique.some(it => it.id === operand.id)) unique.push(operand)
    unique.sort((a, b) => orderOf(a.name) - orderOf(b.name))

    const families: LicenseFamily[] = []
    for (const operand of unique) if (!families.includes(operand.family)) families.push(operand.family)
    if (unique.length === 1) return {name: unique[0].name, family: families}

    const operator = isChoice ? 'OR' : 'AND'
    return {name: `(${unique.map(it => it.name).join(` ${operator} `)})`, family: families}
}

const orderOf = (name: string): number => {
    const index = BD_ORDER.indexOf(name)
    return index === -1 ? BD_ORDER.length : index
}

/**
 * Whether any of these strings names a licence we can read.
 *
 * Used to choose between two candidate licence lists. A registry's per-version field sometimes
 * holds a shorthand that is not an SPDX id at all -- `BSD-like`, `Dual License`, a URL -- while
 * the library-level field holds the clean id. Being more specific does not help if nothing can
 * read it, so a list with no readable name loses to one that has some.
 */
export function hasKnownLicense(licenses: string[]): boolean {
    return licenses.some(it => parseExpression(it).operands.some(operand => operand.id))
}
