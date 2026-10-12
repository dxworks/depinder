/**
 * A licence expression read into a tree, so it can be written back with its structure.
 *
 * Reads SPDX's `AND`, `OR` and brackets, with `AND` binding tighter than `OR`, and crates.io's
 * `MIT/Apache-2.0` shorthand for a choice. `WITH` stays inside its operand: SPDX binds it tightest,
 * and the table names a licence with its exception as one entry.
 */
import {canonicalId, stripOuterParens} from './license-names'

type LicenseOperator = 'AND' | 'OR'

/** One licence as written. `id` is the SPDX id it names, or `''` when it names none we can read. */
export interface LicenseLeaf {
    kind: 'licence'
    text: string
    id: string
}

interface LicenseGroup {
    kind: 'group'
    operator: LicenseOperator
    operands: LicenseNode[]
}

export type LicenseNode = LicenseLeaf | LicenseGroup

type OperatorPatterns = {readonly [operator in LicenseOperator]: RegExp}

/** Operators as SPDX writes them. */
const STRICT: OperatorPatterns = {OR: /\s+OR\s+/g, AND: /\s+AND\s+/g}
/** Registries also write `gpl-3.0 or mit`; this reading is only trusted when it reads every operand. */
const LENIENT: OperatorPatterns = {OR: /\s+(?:or|OR)\s+/g, AND: /\s+(?:and|AND)\s+/g}

/**
 * One licence expression, parsed.
 *
 * The operators are read case-sensitively first. `GNU Lesser General Public License v2.1 or later`
 * is ONE name containing the word "or", so a lower-case operator is only believed when that reading
 * names a licence in every operand. Every piece is also tried whole before it is split.
 */
export function parseLicenseExpression(expression: string): LicenseNode {
    const strict = parseNode(expression, STRICT)
    if (leavesOf(strict).every(it => it.id)) return strict
    const lenient = parseNode(expression, LENIENT)
    return leavesOf(lenient).every(it => it.id) ? lenient : strict
}

/** The licences an expression names, in the order it names them. */
export function leavesOf(node: LicenseNode): LicenseLeaf[] {
    return node.kind === 'licence' ? [node] : node.operands.flatMap(leavesOf)
}

/** Every operator an expression uses, nested ones included. */
export function operatorsOf(node: LicenseNode): LicenseOperator[] {
    if (node.kind === 'licence') return []
    return [node.operator, ...node.operands.flatMap(operatorsOf)]
}

function parseNode(raw: string, operators: OperatorPatterns): LicenseNode {
    const text = stripOuterParens(raw.trim())
    const whole = canonicalId(text)
    if (whole) return {kind: 'licence', text, id: whole}

    // `OR` is split first, so each of its operands keeps its `AND`s together.
    for (const operator of ['OR', 'AND'] as const) {
        const parts = splitOutsideBrackets(text, operators[operator])
        if (parts.length > 1) return groupOf(operator, parts.map(it => parseNode(it, operators)))
    }

    const slashed = text.split('/')
    if (slashed.length > 1 && slashed.every(it => canonicalId(it))) {
        return groupOf('OR', slashed.map(it => parseNode(it, operators)))
    }
    return {kind: 'licence', text, id: ''}
}

/** A group, with nested groups of the same operator folded in: `(A OR B) OR C` is `A OR B OR C`. */
function groupOf(operator: LicenseOperator, operands: LicenseNode[]): LicenseGroup {
    const flat = operands.flatMap(it => (it.kind === 'group' && it.operator === operator ? it.operands : [it]))
    return {kind: 'group', operator, operands: flat}
}

/**
 * Splits on an operator outside brackets. Brackets that do not balance cannot be read as
 * grouping, so then every occurrence splits.
 */
function splitOutsideBrackets(text: string, operator: RegExp): string[] {
    const depths = bracketDepths(text)
    const parts: string[] = []
    let start = 0
    for (const match of text.matchAll(operator)) {
        if (depths && depths[match.index] !== 0) continue
        parts.push(text.slice(start, match.index))
        start = match.index + match[0].length
    }
    parts.push(text.slice(start))
    return parts
}

/** The bracket depth at each position, or `undefined` when the brackets do not balance. */
function bracketDepths(text: string): number[] | undefined {
    const depths: number[] = []
    let depth = 0
    for (let i = 0; i < text.length; i++) {
        if (text[i] === ')') depth--
        if (depth < 0) return undefined
        depths.push(depth)
        if (text[i] === '(') depth++
    }
    return depth === 0 ? depths : undefined
}
