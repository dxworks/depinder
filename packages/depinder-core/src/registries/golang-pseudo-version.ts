/**
 * Go pseudo-versions, by the rules of `golang.org/x/mod/module` (`IsPseudoVersion`,
 * `PseudoVersionTime`). The proxy's `@v/list` never lists them, so the commit time they carry is
 * the only release date such a version has. Three shapes:
 *
 *  - `vX.0.0-<yyyymmddhhmmss>-<rev>`         no earlier tag
 *  - `vX.Y.Z-pre.0.<yyyymmddhhmmss>-<rev>`   after the pre-release tag `vX.Y.Z-pre`
 *  - `vX.Y.(Z+1)-0.<yyyymmddhhmmss>-<rev>`   after the release tag `vX.Y.Z`
 *
 * each optionally followed by `+build` metadata (`+incompatible`).
 */

const PSEUDO_VERSION = /^v[0-9]+\.(0\.0-|\d+\.\d+-([^+]*\.)?0\.)\d{14}-[A-Za-z0-9]+(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/

/** `semver.IsValid` for a full `vX.Y.Z[-pre][+build]`: no leading zeros, no empty identifiers. */
const NUMBER = '(0|[1-9]\\d*)'
const PRERELEASE_ID = '(0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)'
const VALID_SEMVER = new RegExp(
    `^v${NUMBER}\\.${NUMBER}\\.${NUMBER}(-${PRERELEASE_ID}(\\.${PRERELEASE_ID})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$`,
)

/** The UTC commit time a Go pseudo-version carries, or null for any other version string. */
export function pseudoVersionTime(version: string): Date | null {
    if (!isPseudoVersion(version)) return null
    const withoutBuild = version.split('+')[0]!
    const withoutRev = withoutBuild.slice(0, withoutBuild.lastIndexOf('-'))
    // The timestamp follows the last `.` in the `-0.` and `-pre.0.` shapes, the last `-` otherwise.
    const start = Math.max(withoutRev.lastIndexOf('-'), withoutRev.lastIndexOf('.')) + 1
    return parseTimestamp(withoutRev.slice(start))
}

function isPseudoVersion(version: string): boolean {
    return version.split('-').length >= 3 && VALID_SEMVER.test(version) && PSEUDO_VERSION.test(version)
}

/** `yyyymmddhhmmss` as UTC, or null when it names no real instant (month 13, 30 February). */
function parseTimestamp(stamp: string): Date | null {
    const [year, month, day, hour, minute, second] = [0, 4, 6, 8, 10, 12].map((at, i) =>
        Number(stamp.slice(at, i === 0 ? 4 : at + 2)),
    ) as [number, number, number, number, number, number]
    // Set field by field: `Date.UTC` would read years 0-99 as 1900-1999.
    const date = new Date(0)
    date.setUTCFullYear(year, month - 1, day)
    date.setUTCHours(hour, minute, second, 0)
    const roundTrips =
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day &&
        date.getUTCHours() === hour &&
        date.getUTCMinutes() === minute &&
        date.getUTCSeconds() === second
    return roundTrips ? date : null
}
