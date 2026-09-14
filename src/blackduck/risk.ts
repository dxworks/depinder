/**
 * Black Duck's `Operational Risk` column, approximated.
 *
 * This is not a port of Black Duck's model -- that model is not published. It is a rule inferred
 * from the reference export's own 8,384 rows, and the inference is only half the story:
 *
 * Black Duck answers this column from two places. When it has Open Hub telemetry for a project
 * (commit activity, contributors, commits in the past 12 months) it uses it, and can call a
 * component HIGH even when you are on the newest version -- 399 of the 403 rows that are HIGH with
 * zero newer versions carry Open Hub data, while 1,577 of the 1,586 that are OK carry none. Open
 * Hub is Black Duck's own; we have no equivalent and cannot reproduce that branch.
 *
 * When it has no telemetry it falls back to how stale the resolved version is, and THAT is what
 * this reproduces, from two fields every registrar gives us: the release date of the version we
 * resolved, and how many newer versions exist.
 *
 * Measured against the reference export:
 *
 *   all 8,384 components                 79.5% agree
 *   the 6,295 with no Open Hub data      87.8% agree
 *   the 2,089 with Open Hub data         54.5% agree
 *
 * The split is the point. The disagreement is not noise -- it is concentrated exactly where Black
 * Duck knows something we do not, so a row that differs is a row to read, not a row to fix. Adding
 * `newerVersions` as a second threshold was tried and bought 0.6 points, which is fitting to one
 * export rather than learning a rule, so the rule stays at three thresholds.
 */

export type OperationalRisk = 'OK' | 'LOW' | 'MEDIUM' | 'HIGH'

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000

/** Fresh enough to be nobody's problem. */
const LOW_BELOW_YEARS = 2
/** Past this, Black Duck stops calling it merely behind and starts calling it stale. */
const MEDIUM_BELOW_YEARS = 4

/**
 * `''` when we cannot say: no release date, or no answer about newer versions. Black Duck's column
 * distinguishes "we do not know" from a verdict, and so does this -- an empty cell is not `OK`.
 *
 * @param releaseDate `YYYY-MM-DD`, the release date of the resolved version
 * @param newerVersions how many newer versions the registrar knows about, as written to the CSV
 * @param asOf the date the report is written for; defaults to now
 */
export function operationalRisk(releaseDate: string, newerVersions: string, asOf: Date = new Date()): OperationalRisk | '' {
    const newer = Number(newerVersions)
    if (!newerVersions.trim() || !Number.isFinite(newer)) return ''

    // You are on the newest version there is. Nothing to be behind on -- this is the branch where
    // Black Duck's Open Hub data can still overrule us, and the one we knowingly get wrong.
    if (newer === 0) return 'OK'

    const released = new Date(releaseDate)
    if (!releaseDate.trim() || Number.isNaN(released.getTime())) return ''
    const years = (asOf.getTime() - released.getTime()) / YEAR_MS

    if (years < LOW_BELOW_YEARS) return 'LOW'
    if (years < MEDIUM_BELOW_YEARS) return 'MEDIUM'
    return 'HIGH'
}
