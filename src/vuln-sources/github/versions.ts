import * as pep440 from '@renovatebot/pep440'
import * as gemVersion from '@renovatebot/ruby-semver'
import semver from 'semver'
import {ComparatorFamily} from './ecosystems'

/**
 * Version ordering, one comparator per ecosystem family, behind a single interface.
 *
 * A comparator returns <0, 0 or >0, like `Array.prototype.sort`'s callback. This is the whole of
 * the version algebra in this source: `ranges.ts` turns a GitHub `vulnerable_version_range` string
 * into (operator, version) pairs and evaluates each one through a comparator obtained from here.
 *
 * Three of the four families are borrowed rather than written, because getting them subtly wrong
 * is how a vulnerability matcher reports confident nonsense:
 *   - semver  -> node `semver`, loose mode (npm)
 *   - pep440  -> `@renovatebot/pep440` (PyPI: `1.0rc1`, `1.0.post1`, `2!1.0`)
 *   - gem     -> `@renovatebot/ruby-semver` (RubyGems: `1.0.0.pre`, `1.2.3.beta1`)
 *
 * The fourth, `generic`, is ours, and covers maven, nuget, composer, go and cargo. See its
 * documentation below for exactly what it promises and what it does not.
 */
export type VersionComparator = (a: string, b: string) => number

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0)

// ---------------------------------------------------------------------------
// The generic comparator
// ---------------------------------------------------------------------------

/**
 * Maven's qualifier order, which nuget, composer, go and cargo all approximate closely enough:
 * everything below `''` is a pre-release, `''` is the release itself, and `sp` (service pack) is
 * the one qualifier that post-dates a release. Unknown qualifiers sort AFTER the release, ordered
 * lexically among themselves — Maven's own rule.
 */
const QUALIFIER_ORDER = ['alpha', 'beta', 'milestone', 'rc', 'snapshot', '', 'sp']

const QUALIFIER_ALIASES: {readonly [alias: string]: string} = {
    a: 'alpha',
    b: 'beta',
    m: 'milestone',
    cr: 'rc',
    pre: 'alpha',
    preview: 'alpha',
    dev: 'alpha',
    final: '',
    ga: '',
    release: '',
}

/** A version token: either a number or a qualifier word. */
type Token = {kind: 'num', value: number} | {kind: 'str', value: string}

/**
 * Splits a version into comparable tokens.
 *
 * `.`, `-`, `_` and `+` are separators, and a digit/letter boundary is an implicit separator too,
 * so `1.0.0rc1` and `1.0.0-rc-1` tokenise identically. A leading `v` (go, and hand-written cargo
 * ranges) is dropped, as is `+incompatible` / any build metadata after `+`, which by both SemVer
 * and Go's rules does not participate in ordering.
 */
export function tokenizeVersion(version: string): Token[] {
    const cleaned = version.trim().replace(/^[vV](?=\d)/, '').split('+')[0]
    const tokens: Token[] = []
    for (const part of cleaned.split(/[.\-_]/)) {
        if (!part) continue
        for (const piece of part.match(/\d+|[^\d]+/g) ?? []) {
            if (/^\d+$/.test(piece)) tokens.push({kind: 'num', value: Number(piece)})
            else {
                const word = piece.toLowerCase()
                tokens.push({kind: 'str', value: QUALIFIER_ALIASES[word] ?? word})
            }
        }
    }
    return tokens
}

function qualifierRank(value: string): number {
    const known = QUALIFIER_ORDER.indexOf(value)
    // Unknown qualifiers sit above every known one and are then ordered lexically.
    return known >= 0 ? known : QUALIFIER_ORDER.length
}

function compareTokens(a: Token | undefined, b: Token | undefined): number {
    // A missing token is padded: numerically 0 (so `1.0` == `1.0.0`), textually the release
    // qualifier `''` (so `1.0` > `1.0-rc1` and `1.0` < `1.0-sp1`).
    const left = a ?? (b?.kind === 'num' ? {kind: 'num', value: 0} as Token : {kind: 'str', value: ''} as Token)
    const right = b ?? (a?.kind === 'num' ? {kind: 'num', value: 0} as Token : {kind: 'str', value: ''} as Token)

    if (left.kind === 'num' && right.kind === 'num') return sign(left.value - right.value)
    // A number always outranks a qualifier word: `1.0.1` > `1.0.rc`.
    if (left.kind === 'num') return 1
    if (right.kind === 'num') return -1

    const rankDiff = qualifierRank(left.value) - qualifierRank(right.value)
    if (rankDiff !== 0) return sign(rankDiff)
    return sign(left.value < right.value ? -1 : left.value > right.value ? 1 : 0)
}

/**
 * The comparator for maven, nuget, composer, go and cargo.
 *
 * What it promises: numeric segments compare numerically and of any length (`2.10 > 2.9`,
 * `1.2.3.4 > 1.2.3`); trailing zero segments are insignificant (`1.0` == `1.0.0`); pre-release
 * qualifiers order alpha < beta < milestone < rc < snapshot < release < sp, with unknown
 * qualifiers after the release; a pre-release is always below its release (`1.0.0-rc1 < 1.0.0`);
 * case and separator style are insignificant; build metadata after `+` is ignored.
 *
 * What it does not promise: Composer's `dev-<branch>` names, which are unordered by construction,
 * and NuGet's SemVer2 rule that a longer pre-release identifier list wins ties. Both are rare in
 * advisory ranges and both fail towards "not affected" rather than towards a false positive,
 * because an unorderable token compares as an unknown qualifier and lands above the release.
 */
export function compareGeneric(a: string, b: string): number {
    const left = tokenizeVersion(a)
    const right = tokenizeVersion(b)
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const result = compareTokens(left[i], right[i])
        if (result !== 0) return result
    }
    return 0
}

// ---------------------------------------------------------------------------
// The borrowed comparators, each falling back to `generic` on input it cannot parse
// ---------------------------------------------------------------------------

/**
 * A library comparator that refuses one of its operands must not throw: advisory ranges and SBOM
 * versions both contain shapes no library accepts (`1.0.0.RELEASE` in a maven-flavoured npm
 * range, `UNKNOWN` from Syft). Falling back to the generic order keeps the answer plausible
 * instead of dropping the advisory silently.
 */
function withFallback(valid: (v: string) => boolean, compare: (a: string, b: string) => number): VersionComparator {
    return (a, b) => {
        if (!valid(a) || !valid(b)) return compareGeneric(a, b)
        try {
            return sign(compare(a, b))
        } catch {
            return compareGeneric(a, b)
        }
    }
}

export const compareSemver: VersionComparator = withFallback(
    v => semver.valid(v, {loose: true}) !== null,
    (a, b) => semver.compare(a, b, {loose: true})
)

export const comparePep440: VersionComparator = withFallback(
    v => !!pep440.valid(v),
    (a, b) => pep440.compare(a, b)
)

/** `@renovatebot/ruby-semver` exposes predicates rather than a comparator; build one from them. */
export const compareGem: VersionComparator = withFallback(
    v => !!gemVersion.valid(v),
    (a, b) => (gemVersion.eq(a, b) ? 0 : gemVersion.gt(a, b) ? 1 : -1)
)

const COMPARATORS: {readonly [family in ComparatorFamily]: VersionComparator} = {
    semver: compareSemver,
    pep440: comparePep440,
    gem: compareGem,
    generic: compareGeneric,
}

export function comparatorFor(family: ComparatorFamily): VersionComparator {
    return COMPARATORS[family]
}
