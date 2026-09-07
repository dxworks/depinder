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
    'Ruby': {name: 'Ruby License', family: 'PERMISSIVE'},
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
}

/** Black Duck's own wording for a component whose licence it could not determine. */
const UNKNOWN: KnownLicense = {name: 'Unknown License', family: 'UNKNOWN'}

/**
 * The licence columns for one component.
 *
 * A component can carry several licences, and an SPDX expression (`MIT OR Apache-2.0`) is one
 * cell holding several too. Black Duck writes an expression as `(MIT License OR Apache License
 * 2.0)` and a genuine multi-licence component as a comma-joined list, with the families joined
 * the same way and de-duplicated — so both are reproduced here rather than flattened to one name.
 */
export function licenseColumns(licenses: string[]): {names: string, families: string} {
    const present = licenses.map(it => it.trim()).filter(it => it.length > 0)
    if (present.length === 0) return {names: UNKNOWN.name, families: UNKNOWN.family}

    const names: string[] = []
    const families: string[] = []
    for (const license of present) {
        const {name, family} = describeExpression(license)
        names.push(name)
        for (const it of family) if (!families.includes(it)) families.push(it)
    }
    return {names: names.join(','), families: families.join(',')}
}

/** Splits an SPDX expression on its operators, maps each operand, and rebuilds it in BD's shape. */
function describeExpression(expression: string): {name: string, family: LicenseFamily[]} {
    const parts = expression.split(/\s+(AND|OR)\s+/i)
    if (parts.length === 1) {
        const known = LICENSES[normalizeId(expression)] ?? {name: expression, family: 'UNKNOWN' as const}
        return {name: known.name, family: [known.family]}
    }
    const families: LicenseFamily[] = []
    const rendered = parts.map((part, index) => {
        // Odd indices are the captured operators, which Black Duck upper-cases.
        if (index % 2 === 1) return part.toUpperCase()
        const known = LICENSES[normalizeId(part)] ?? {name: part.trim(), family: 'UNKNOWN' as const}
        if (!families.includes(known.family)) families.push(known.family)
        return known.name
    })
    return {name: `(${rendered.join(' ')})`, family: families}
}

/** `Apache-2.0+`, `apache-2.0` and `Apache-2.0` are the same entry; the `+` is "or later". */
function normalizeId(id: string): string {
    const trimmed = id.trim().replace(/[()+]/g, '')
    const match = Object.keys(LICENSES).find(it => it.toLowerCase() === trimmed.toLowerCase())
    return match ?? trimmed
}
