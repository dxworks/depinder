import {VersionComparator} from './versions'

/**
 * GitHub's `vulnerable_version_range` grammar, which is far smaller than any package manager's
 * range syntax and is the same for every ecosystem:
 *
 *     range      := constraint ("," constraint)*     -- comma means AND
 *     constraint := ("=" | "<" | "<=" | ">" | ">=") version
 *
 * Real examples: `< 1.2.3`, `>= 1.0, < 1.2.3`, `= 1.0.0`, `<= 2.4.1`.
 *
 * Deliberately NOT supported, because GitHub does not emit them here: `~`, `^`, `*`, `||`, and
 * hyphen ranges. An unparseable constraint makes the whole range unsatisfiable rather than
 * universally satisfied — a matcher that cannot read a range must not claim every version is
 * vulnerable.
 */

export type RangeOperator = '=' | '<' | '<=' | '>' | '>='

export interface Constraint {
    operator: RangeOperator
    version: string
}

const CONSTRAINT_PATTERN = /^(<=|>=|=|<|>)?\s*(.+)$/

export function parseRange(range: string): Constraint[] | undefined {
    const parts = range.split(',').map(it => it.trim()).filter(it => it.length > 0)
    if (parts.length === 0) return undefined

    const constraints: Constraint[] = []
    for (const part of parts) {
        const match = CONSTRAINT_PATTERN.exec(part)
        if (!match) return undefined
        const version = match[2].trim()
        if (!version || /[\s|^~*]/.test(version)) return undefined
        // A bare version with no operator means equality; GitHub writes `= 1.0.0` but not always.
        constraints.push({operator: (match[1] as RangeOperator) ?? '=', version})
    }
    return constraints
}

export function satisfiesConstraint(version: string, constraint: Constraint, compare: VersionComparator): boolean {
    const result = compare(version, constraint.version)
    switch (constraint.operator) {
        case '=': return result === 0
        case '<': return result < 0
        case '<=': return result <= 0
        case '>': return result > 0
        case '>=': return result >= 0
    }
}

/** True iff `version` satisfies every constraint in `range`. An unparseable range is never met. */
export function satisfiesRange(version: string, range: string, compare: VersionComparator): boolean {
    const constraints = parseRange(range)
    if (!constraints) return false
    return constraints.every(it => satisfiesConstraint(version, it, compare))
}
