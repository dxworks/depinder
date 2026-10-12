/**
 * The licence cells of both outputs: Black Duck's `License names`, `License families` and `License
 * Risk` columns, and the licence `<plugin>-licenses.csv` groups a library under.
 *
 * The table of licences and the reading of one name are in `license-names.ts`; the reading of an
 * expression is in `license-expression.ts`. This file writes what they read.
 */
import {LicenseFamily, LICENSES, UNKNOWN, unreadableName} from './license-names'
import {LicenseLeaf, LicenseNode, leavesOf, operatorsOf, parseLicenseExpression} from './license-expression'

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

const orderOf = (name: string): number => {
    const index = BD_ORDER.indexOf(name)
    return index === -1 ? BD_ORDER.length : index
}

/** Black Duck's order for one operator group; operands it has no place for keep theirs, last. */
function inBlackDuckOrder<T extends LicenseNode>(operands: T[]): T[] {
    const rank = (node: LicenseNode): number =>
        (node.kind === 'licence' && node.id ? orderOf(LICENSES[node.id].name) : BD_ORDER.length)
    return [...operands].sort((a, b) => rank(a) - rank(b))
}

/** How one output spells a licence: Black Duck's display name, or the SPDX id. */
type Spelling = (leaf: LicenseLeaf) => string

const blackDuckName: Spelling = leaf => (leaf.id ? LICENSES[leaf.id].name : unreadableName(leaf.text) ?? UNKNOWN.name)
const spdxId: Spelling = leaf => leaf.id || (unreadableName(leaf.text) ?? 'unknown')

/**
 * An expression written back with its structure: every group in Black Duck's order, its operands
 * de-duplicated, and bracketed when it is nested and still holds more than one.
 */
function written(node: LicenseNode, spell: Spelling, nested: boolean): string {
    if (node.kind === 'licence') return spell(node)
    const operands = [...new Set(inBlackDuckOrder(node.operands).map(it => written(it, spell, true)))]
    const text = operands.join(` ${node.operator} `)
    return nested && operands.length > 1 ? `(${text})` : text
}

/** Whether any licence in the expression is one we can read. */
const namesKnownLicense = (expression: LicenseNode): boolean => leavesOf(expression).some(it => it.id)

/** The risk of the licences we could read, with the ones we could not taken into account. */
function riskOf(expression: LicenseNode): LicenseRisk {
    const leaves = leavesOf(expression)
    const readable = leaves.filter(it => it.id)
    const risks = readable.map(it => FAMILY_RISK[LICENSES[it.id].family as Exclude<LicenseFamily, 'UNKNOWN'>])
    const unreadable = leaves.length !== readable.length
    const operators = operatorsOf(expression)
    const isChoice = operators.length > 0 && operators.every(it => it === 'OR')
    return isChoice ? choice(risks, unreadable) : conjunction(risks, unreadable)
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
 * An expression that mixes operators (`A OR B AND C`, `A AND (B OR C)`) is read as a conjunction
 * of all its licences. Precedence is not modelled here, and over-reporting risk is the safe
 * direction to be wrong in.
 */
export function licenseRisk(licenses: string[]): LicenseRisk {
    const present = licenses.map(it => it.trim()).filter(it => it.length > 0)
    if (present.length === 0) return 'UNKNOWN'
    // Several licences side by side are a conjunction -- see `licenseColumns` for why.
    const risks = present.map(it => riskOf(parseLicenseExpression(it)))
    const readable = risks.filter(it => it !== 'UNKNOWN') as KnownRisk[]
    return conjunction(readable, readable.length !== risks.length)
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
 * The licence `<plugin>-licenses.csv` groups a library under: the same reading the Black Duck
 * columns make, written as SPDX ids (`MIT OR Apache-2.0`) instead of display names. Text that
 * names no licence is kept as it is, or is `unknown` when it is not a name at all.
 */
export function licenseIdentity(license: string): string {
    const expression = parseLicenseExpression(license)
    if (!namesKnownLicense(expression)) return unreadableName(license) ?? 'unknown'
    return written(expression, spdxId, false)
}

/**
 * Rebuilds an expression in Black Duck's shape and order. Its families are those of every licence
 * it names, in that order, with `UNKNOWN` standing for the ones we cannot read.
 */
function describeExpression(license: string): {name: string, family: LicenseFamily[]} {
    const expression = parseLicenseExpression(license)
    if (!namesKnownLicense(expression)) return {name: unreadableName(license) ?? UNKNOWN.name, family: ['UNKNOWN']}

    const leaves = inBlackDuckOrder(leavesOf(expression))
    const families = [...new Set(leaves.map(it => (it.id ? LICENSES[it.id].family : UNKNOWN.family)))]
    return {name: written(expression, blackDuckName, true), family: families}
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
    return licenses.some(it => namesKnownLicense(parseLicenseExpression(it)))
}
