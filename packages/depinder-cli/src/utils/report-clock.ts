/**
 * The "today" a report is written for: the Now-Used and Now-latest columns, the Out of Support
 * counts and Black Duck's Operational Risk all measure age from it.
 *
 * `DEPINDER_REPORT_NOW` fixes it, so tests and the bench get CSVs that do not change by themselves
 * over time. It moves nothing else: cache freshness, the resolver's `max_age`, logs and folder
 * names keep reading the real clock.
 */

export const REPORT_NOW_ENV = 'DEPINDER_REPORT_NOW'

/** A date, optionally with a time and an offset: `2026-10-03`, `2026-10-03T14:30:00Z`. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** Parses a fixed report date; throws with a message naming the variable when it is not ISO 8601. */
export function parseReportNow(raw: string): Date {
    const parsed = new Date(raw.trim())
    if (!ISO_DATE_TIME.test(raw.trim()) || Number.isNaN(parsed.getTime())) {
        throw new Error(`${REPORT_NOW_ENV}=${raw} is not an ISO 8601 date (e.g. 2026-10-03 or 2026-10-03T14:30:00Z)`)
    }
    return parsed
}

/** The fixed report date, or `undefined` when the report follows the real clock. */
export function fixedReportNow(): Date | undefined {
    const raw = process.env[REPORT_NOW_ENV]
    return raw ? parseReportNow(raw) : undefined
}

/** The moment a report measures age from: the fixed date when one is set, else the real now. */
export function reportNow(): Date {
    return fixedReportNow() ?? new Date()
}
