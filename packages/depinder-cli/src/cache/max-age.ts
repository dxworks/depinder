import {log} from '../utils/logging'

/**
 * How old a cached package may be before it counts as missing.
 *
 * Every row of the `libs` table carries `updated_at`, the moment its facts were last confirmed
 * against the registry: when depinder fetched them itself, the moment it wrote the row; when the
 * resolver answered, the server's own `confirmed_at`, which can be much older. A row confirmed at or
 * after the run's cutoff (`run start − max age`) is fresh and answered locally; an older one is
 * expired: it is asked for again — the resolver in bulk first, then the registrar — and whatever
 * answers rewrites it. An expired row that nothing answers for is treated exactly like a row that
 * was never cached.
 *
 * So a `refreshing` resolver answer — facts the server could not reconfirm within the max age — is
 * written already expired. This run still uses it (phase 3 reads the bulk phase's answers from
 * memory first), and the next run asks the server for it again rather than trusting it for another
 * full max age because it happened to be copied here recently.
 *
 * `--cache-max-age <duration>` overrides `DEPINDER_CACHE_MAX_AGE`; both take `<n>[s|m|h|d]`, a
 * bare number being seconds. The resolver is held to the same cutoff: every request carries
 * `max_age`, the seconds from the cutoff to the moment of the post (`maxAgeFor` in
 * `resolver/client.ts`), and the server answers what it has not confirmed since as `refreshing`.
 *
 * Separate from the miss TTL (`MISS_TTL_HOURS`) on purpose: that one decides how soon a lookup
 * that FAILED is retried, and a long max age should not mean a 404 is never retried.
 */

export const DEFAULT_CACHE_MAX_AGE = '1d'

const UNIT_SECONDS: Record<string, number> = {s: 1, m: 60, h: 3600, d: 86400}

/** `<n>[s|m|h|d]` → whole seconds; a bare number is seconds. `undefined` when it does not parse. */
export function parseDuration(raw: string): number | undefined {
    const match = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(raw)
    if (!match) return undefined
    const seconds = Number(match[1]) * UNIT_SECONDS[(match[2] || 's').toLowerCase()]
    return Number.isFinite(seconds) ? Math.round(seconds) : undefined
}

export interface CacheMaxAgeOptions {
    /** `--cache-max-age <duration>`. Overrides `DEPINDER_CACHE_MAX_AGE`. */
    cacheMaxAge?: string
}

/** The max age for this run, in seconds: the flag, else the environment, else one day. */
export function cacheMaxAgeSeconds(options: CacheMaxAgeOptions = {}): number {
    const fallback = parseDuration(DEFAULT_CACHE_MAX_AGE) as number
    const [raw, source] = options.cacheMaxAge !== undefined
        ? [options.cacheMaxAge, '--cache-max-age']
        : [process.env.DEPINDER_CACHE_MAX_AGE, 'DEPINDER_CACHE_MAX_AGE']
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = parseDuration(raw)
    if (parsed === undefined) {
        log.warn(`Ignoring ${source}=${raw}: not a duration like 90s, 30m, 12h or 1d; using ${DEFAULT_CACHE_MAX_AGE}`)
        return fallback
    }
    return parsed
}

/** Rows written before this instant (epoch milliseconds) are expired. Computed once per run. */
export function freshnessCutoffMs(maxAgeSeconds: number, now = Date.now()): number {
    return now - maxAgeSeconds * 1000
}

/** `86400` → `1d`, `5400` → `90m`: the largest unit that divides it, for log lines. */
export function formatDuration(seconds: number): string {
    for (const unit of ['d', 'h', 'm']) {
        const size = UNIT_SECONDS[unit]
        if (seconds > 0 && seconds % size === 0) return `${seconds / size}${unit}`
    }
    return `${seconds}s`
}
