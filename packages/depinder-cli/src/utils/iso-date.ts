/** UTC calendar date, or undefined when the timestamp is missing or invalid. */
export function isoDate(timestamp: number | undefined): string | undefined {
    if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined
    const date = new Date(timestamp)
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
}
