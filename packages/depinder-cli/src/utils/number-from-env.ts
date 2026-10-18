import {log} from './logging'

export interface EnvNumberRule {
    /** What one unit of the value counts, for the warning: `milliseconds`, `chunks`. */
    unit: string
    /** Only whole numbers are accepted; a fraction is ignored like any other bad value. */
    wholeNumber?: boolean
}

/**
 * A positive number from the environment variable `name`, or `fallback` when it is unset or blank.
 * Anything else that is not a positive (whole, when asked) number is ignored with a warning.
 */
export function positiveNumberFromEnv(name: string, fallback: number, rule: EnvNumberRule): number {
    const raw = process.env[name]?.trim()
    if (!raw) return fallback
    const parsed = Number(raw)
    const wholeNumber = rule.wholeNumber ?? false
    if (!Number.isFinite(parsed) || parsed <= 0 || (wholeNumber && !Number.isInteger(parsed))) {
        log.warn(`Ignoring ${name}=${raw}: not a positive ${wholeNumber ? 'whole number' : 'number'} of ${rule.unit}`)
        return fallback
    }
    return parsed
}
