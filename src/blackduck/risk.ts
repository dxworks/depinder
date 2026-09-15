/**
 * Black Duck's `Operational Risk` column, reproduced for the components Black Duck grades without
 * Open Hub telemetry.
 *
 * This is not a port of Black Duck's model -- that model is not published. It is a rule measured
 * on the reference export's own rows, and the measurement is only half the story:
 *
 * Black Duck answers this column from two places. When it has Open Hub telemetry for a project
 * (commit activity, contributors, commits in the past 12 months) it uses it, and can call a
 * component HIGH even when you are on the newest version -- 399 of the 403 rows that are HIGH with
 * zero newer versions carry Open Hub data, while 1,577 of the 1,586 that are OK carry none. Open
 * Hub is Black Duck's own; we have no equivalent and cannot reproduce that branch.
 *
 * When it has no telemetry it falls back to two fields every registrar gives us: how many newer
 * versions exist, and how old the resolved version is. THAT is what this reproduces.
 *
 * The rule was read off a cross-tab of `Newer Versions` x age (as of 2026-09-10, the export's date)
 * over the 6,295 rows of the reference export that have empty `Commit Activity` and `Commits in
 * Past 12 Months`. Every cell of that table is unanimous -- zero exceptions:
 *
 *   newer versions <= 1   OK, whatever the age
 *   newer versions == 2   LOW below 4 years, MEDIUM from 4 years on; never HIGH
 *   newer versions >= 3   LOW below 2 years, MEDIUM from 2 to 4 years, HIGH from 4 years on
 *
 * So one newer version is not "behind" to Black Duck, two newer versions are capped at MEDIUM, and
 * the two-and-four-year thresholds only take full effect from three newer versions up. An earlier
 * version of this file graded purely by age once any newer version existed; that reached 87.8%
 * agreement on the same rows and its misses were exactly the `<= 1` and `== 2` columns above.
 *
 * On the 2,089 rows that do carry Open Hub data the rule is, by construction, only sometimes right:
 * a row there that differs from Black Duck is a row where Black Duck knows something we do not --
 * a row to read, not a row to fix.
 */

export type OperationalRisk = 'OK' | 'LOW' | 'MEDIUM' | 'HIGH'

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000

/** Being at most this many versions behind is not being behind at all. */
const NEWER_STILL_OK = 1
/** Exactly this many newer versions never gets past MEDIUM. */
const NEWER_CAPPED_AT_MEDIUM = 2

/** Below this age a version you are behind on is merely behind. */
const LOW_BELOW_YEARS = 2
/** Past this, Black Duck stops calling it merely behind and starts calling it stale. */
const MEDIUM_BELOW_YEARS = 4

/**
 * `''` when we cannot say: no answer about newer versions, or -- once the verdict depends on age --
 * no release date. Black Duck's column distinguishes "we do not know" from a verdict, and so does
 * this -- an empty cell is not `OK`.
 *
 * @param releaseDate `YYYY-MM-DD`, the release date of the resolved version
 * @param newerVersions how many newer versions the registrar knows about, as written to the CSV
 * @param asOf the date the report is written for; defaults to now
 */
export function operationalRisk(releaseDate: string, newerVersions: string, asOf: Date = new Date()): OperationalRisk | '' {
    const newer = Number(newerVersions)
    if (!newerVersions.trim() || !Number.isFinite(newer)) return ''

    // Newest, or one behind: nothing to be behind on, whatever the age. This is the branch where
    // Black Duck's Open Hub data can still overrule us, and the one we knowingly get wrong.
    if (newer <= NEWER_STILL_OK) return 'OK'

    const released = new Date(releaseDate)
    if (!releaseDate.trim() || Number.isNaN(released.getTime())) return ''
    const years = (asOf.getTime() - released.getTime()) / YEAR_MS

    if (newer === NEWER_CAPPED_AT_MEDIUM) return years < MEDIUM_BELOW_YEARS ? 'LOW' : 'MEDIUM'

    if (years < LOW_BELOW_YEARS) return 'LOW'
    if (years < MEDIUM_BELOW_YEARS) return 'MEDIUM'
    return 'HIGH'
}
