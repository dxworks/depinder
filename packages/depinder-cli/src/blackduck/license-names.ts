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

export interface KnownLicense {
    name: string
    family: LicenseFamily
}

export const LICENSES: {readonly [spdxId: string]: KnownLicense} = {
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
export const UNKNOWN: KnownLicense = {name: 'Unknown License', family: 'UNKNOWN'}

// Everything below reads ONE vocabulary: whatever a registry, an SBOM or a finished export
// happens to hold. `Apache-2.0`, `Apache License 2.0`, `Apache License, Version 2.0`, `The Apache
// Software License, Version 2.0` and `Apache 2` are the same licence written five ways; a name
// that is not read is counted as UNKNOWN, which reports the component at HIGH risk.
//
// The rules are deliberately conservative. A string that cannot be resolved to an entry in the
// table stays unresolved and the risk becomes `UNKNOWN` -- guessing a licence is worse than
// admitting we cannot read one.

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

/** Removes brackets that wrap the whole text, however many pairs: `((MIT))` is `MIT`. */
export function stripOuterParens(text: string): string {
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
 * Text naming no licence we can read, kept as written -- unless it is not a name at all (a URL,
 * a pasted licence file), where `undefined` lets the caller say "unknown" instead.
 */
export function unreadableName(expression: string): string | undefined {
    const text = stripOuterParens(expression.trim())
    const usable = text.length > 0 && text.length <= MAX_NAME_LENGTH && !/https?:\/\//i.test(text)
    return usable ? text : undefined
}
