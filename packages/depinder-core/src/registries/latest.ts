/**
 * The latest-version policy, in one place because it is the answer depinder shows to users and
 * the one number everyone disagrees about.
 *
 *  - `latest` is the registry's own designation when the registry has one: npm `dist-tags.latest`,
 *    pypi `info.version`, gem `gems/<g>.json .version`, golang `@latest`, cargo
 *    `max_stable_version`, maven `<release>` (once `maven/metadata.ts` has vetted it).
 *  - nuget and composer designate nothing, and get the **highest version** among versions that
 *    are not pre-releases, by version order. Release dates are the wrong key there: both
 *    ecosystems keep several majors alive, so the newest publish is routinely a servicing
 *    release of an older line (`Microsoft.Extensions.Logging` 9.0.20 shipping after 10.0.12,
 *    `laravel/framework` v11.x after v13.x). nuget.org's own search (`prerelease=false`) answers
 *    by version too.
 *  - maven without a usable `<release>` gets the newest release date among versions that are not
 *    pre-releases — Central's version strings are too irregular to order safely, its deploy
 *    order is what `<release>` means anyway — with version order breaking ties between versions
 *    deployed in the same minute (old artifacts were bulk-imported with one timestamp).
 *  - A maven latest with a letter-led `-qualifier` gives way to its plain sibling when one exists:
 *    byte-buddy deploys `1.18.14` and `1.18.14-jdk5`, and the plain one is the main artifact.
 *    Guava's `-jre` / `-android` have no plain sibling and are untouched.
 *  - `latestPrerelease` is the newest version overall (highest, for nuget and composer),
 *    reported only when it differs from `latest`. It is therefore not always a pre-release: a
 *    package whose newest publish is a stable version that the registry has not promoted to
 *    `latest` yet shows up here too, which is what a consumer wants to know.
 *  - Yanked / unlisted versions never win either slot, and neither do composer branches
 *    (`dev-master`, `1.x-dev`): a branch is not a release, even when it is all a package has
 *    besides pre-releases.
 */

export interface VersionLike {
    version: string
    releasedAt: Date | null
    prerelease: boolean
    yanked: boolean
}

interface LatestResult {
    latest?: string
    latestPrerelease?: string
}

/** The plan's keyword rule. Matched anywhere in the version string, case-insensitively. */
const PRERELEASE_KEYWORD = /(alpha|beta|rc|milestone|snapshot|preview|dev|m\d+|cr\d+)/i

/** A semver core followed by a `-pre.release` part (build metadata stripped first). */
const SEMVER_PRERELEASE = /^\d+(\.\d+){0,2}-[0-9A-Za-z.-]+$/

/** PEP 440 pre-release and developmental-release segments: `1.0a1`, `2.0.0rc2`, `1.0.0.dev3`. */
const PEP440_PRERELEASE = /(?:^|[.\-_]|\d)(a|b|c|rc|alpha|beta|pre|preview|dev)[.\-_]?\d*$/i

/** Ecosystems whose `latest` is decided by version order rather than by release date. */
const VERSION_ORDERED = new Set(['nuget', 'composer'])

/**
 * Whether a version string names a pre-release.
 *
 * Two ecosystem carve-outs:
 *  - maven is exempt from the semver rule, because `-` there separates a qualifier rather than a
 *    pre-release tag: `32.1.2-jre` and `32.1.2-android` are guava's two shipping flavours, not
 *    release candidates. Maven still gets the keyword rule, which catches `-SNAPSHOT`, `-RC1`, `-M2`.
 *  - composer treats `dev-<branch>` and `<branch>-dev` as pre-releases by definition.
 */
export function isPrerelease(type: string, version: string): boolean {
    const v = version.trim()
    if (!v) return false
    if (isBranch(type, v)) return true
    if (type === 'pypi' && PEP440_PRERELEASE.test(v)) return true
    if (type !== 'maven' && SEMVER_PRERELEASE.test(stripBuildMetadata(v))) return true
    return PRERELEASE_KEYWORD.test(v)
}

/** A composer branch — `dev-master`, `1.x-dev` — rather than a tagged release. */
function isBranch(type: string, version: string): boolean {
    const v = version.trim()
    return type === 'composer' && (/^dev-/i.test(v) || /-dev$/i.test(v))
}

function stripBuildMetadata(version: string): string {
    const core = version.startsWith('v') || version.startsWith('V') ? version.slice(1) : version
    const plus = core.indexOf('+')
    return plus === -1 ? core : core.slice(0, plus)
}

/**
 * @param registryLatest the registry's own "latest" designation, when it publishes one. Ignored
 *        if it names a version that is missing from the list or yanked.
 */
export function computeLatest(
    type: string,
    versions: readonly VersionLike[],
    registryLatest?: string | null,
): LatestResult {
    const usable = versions.filter(v => !v.yanked && !isBranch(type, v.version))
    if (usable.length === 0) return {}

    const pick = VERSION_ORDERED.has(type) ? highest : newest

    let latest: string | undefined
    if (registryLatest) {
        latest = usable.find(v => v.version === registryLatest)?.version
    }
    if (!latest) {
        const stable = usable.filter(v => !v.prerelease)
        // Every version looking like a pre-release (a package that only ever shipped snapshots,
        // or maven flavour suffixes the keyword rule caught) still deserves a latest: the newest
        // one is a better answer than nothing.
        latest = pick(stable.length > 0 ? stable : usable)?.version
    }
    if (latest && type === 'maven') latest = plainSibling(usable, latest)

    const newestOverall = pick(usable)?.version
    const latestPrerelease = newestOverall && newestOverall !== latest ? newestOverall : undefined

    return {latest, latestPrerelease}
}

/**
 * A letter-led maven qualifier (`1.18.14-jdk5`) yields to the plain version with the same core
 * (`1.18.14`) when that one exists. Numeric qualifiers (`1.0-1`, a rebuild) and dot-separated
 * ones (`2.0.1.MR`, `5.6.15.Final`) are left alone: those are the release, not a flavour of it.
 */
function plainSibling(versions: readonly VersionLike[], latest: string): string {
    const match = /^(\d+(?:\.\d+)*)-[A-Za-z]/.exec(latest)
    if (!match) return latest
    const core = match[1]
    return versions.some(v => v.version === core && !v.prerelease) ? core! : latest
}

/**
 * Newest by release date. Undated versions lose to dated ones; among undated versions the last
 * one in the list wins, because every registry we read lists versions oldest-first. Two versions
 * with the same date are ordered by version, the list order deciding only between equals.
 */
function newest<T extends VersionLike>(list: readonly T[]): T | undefined {
    let best: T | undefined
    for (const candidate of list) {
        if (!best) {
            best = candidate
            continue
        }
        const a = candidate.releasedAt?.getTime()
        const b = best.releasedAt?.getTime()
        if (a !== undefined && b !== undefined) {
            if (a > b || (a === b && compareVersions(candidate.version, best.version) >= 0)) best = candidate
        } else if (a !== undefined) {
            best = candidate
        } else if (b === undefined) {
            best = candidate
        }
    }
    return best
}

/** Highest by {@link compareVersions}; between equal versions the later one in the list wins. */
export function highest<T extends VersionLike>(list: readonly T[]): T | undefined {
    let best: T | undefined
    for (const candidate of list) {
        if (!best || compareVersions(candidate.version, best.version) >= 0) best = candidate
    }
    return best
}

/** `1.2.3-rc.1+build` -> numeric core `[1, 2, 3]`, qualifier `rc.1`. */
interface ParsedVersion {
    core: number[]
    qualifier: string
}

function parseVersion(version: string): ParsedVersion {
    const v = stripBuildMetadata(version.trim())
    const match = /^(\d+(?:\.\d+)*)(.*)$/.exec(v)
    if (!match) return {core: [], qualifier: v}
    return {
        core: match[1]!.split('.').map(Number),
        qualifier: match[2]!.replace(/^[.\-_]+/, ''),
    }
}

/** Qualifiers that mean "this is the release" rather than naming a pre-release or a flavour. */
const RELEASE_QUALIFIER = /^(final|ga|release)$/i

/**
 * A date-stamped version — `20020529`, `20040616` — the way some artifacts were numbered before
 * they adopted real versions. Numerically it dwarfs every `2.0` that came after it, so it ranks
 * below any ordinary version instead.
 */
function isDateStamp(core: number[]): boolean {
    const first = core[0]
    return first !== undefined && first >= 19_000_000 && first < 30_000_000
}

/**
 * Version order, good enough for nuget (NuGet SemVer: up to four numeric parts, `-label`
 * pre-releases, `+metadata` ignored) and composer (`v` prefix, `-beta2`, `-RC1`):
 *
 *  - the numeric core is compared part by part, missing parts counting as 0 (`1.0` = `1.0.0`);
 *  - a date stamp ranks below any ordinary version (see {@link isDateStamp});
 *  - with equal cores, no qualifier beats any qualifier (`1.0.0` > `1.0.0-rc.1`), `Final` / `GA`
 *    / `RELEASE` counting as none;
 *  - two qualifiers are split into runs of digits and of letters (`rc.10` -> `rc`, `10`;
 *    `beta2` -> `beta`, `2`) and compared run by run: numbers numerically, words
 *    case-insensitively, a number below a word, and a qualifier that runs out first is lower.
 *
 * Returns a negative number, zero or a positive number, as `Array.prototype.sort` wants.
 */
export function compareVersions(a: string, b: string): number {
    const pa = parseVersion(a)
    const pb = parseVersion(b)

    if (pa.core.length === 0 || pb.core.length === 0) {
        if (pa.core.length !== pb.core.length) return pa.core.length === 0 ? -1 : 1
    }
    const da = isDateStamp(pa.core)
    const db = isDateStamp(pb.core)
    if (da !== db) return da ? -1 : 1

    for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
        const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
        if (diff !== 0) return diff
    }

    const qa = RELEASE_QUALIFIER.test(pa.qualifier) ? '' : pa.qualifier
    const qb = RELEASE_QUALIFIER.test(pb.qualifier) ? '' : pb.qualifier
    if (!qa || !qb) return qa === qb ? 0 : qa ? -1 : 1

    const ta = qa.match(/\d+|[A-Za-z]+/g) ?? []
    const tb = qb.match(/\d+|[A-Za-z]+/g) ?? []
    for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
        const x = ta[i]!
        const y = tb[i]!
        const nx = /^\d/.test(x)
        const ny = /^\d/.test(y)
        if (nx && ny) {
            const diff = Number(x) - Number(y)
            if (diff !== 0) return diff
        } else if (nx !== ny) {
            return nx ? -1 : 1
        } else {
            const lx = x.toLowerCase()
            const ly = y.toLowerCase()
            if (lx !== ly) return lx < ly ? -1 : 1
        }
    }
    return ta.length - tb.length
}
