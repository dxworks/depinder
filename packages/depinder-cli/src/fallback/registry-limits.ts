import {isSupportedType, SUPPORTED_TYPES, type EcosystemLimits, type LimitSpec} from '@depinder/core'

/**
 * The CLI's registry limits (D18): requests in flight at once, and the gap between their starts,
 * per purl type. Defaults are at least as fast as the registrars they replace; users override
 * them per ecosystem. Only the speed depends on these numbers, never the facts.
 */

export const REGISTRY_LIMITS_ENV = 'DEPINDER_REGISTRY_LIMITS'

/** Dependencies one plugin looks up at once, as the registrars did before core. */
export const DEFAULT_PACKAGES_AT_ONCE = 8

const DEFAULT_LIMIT: LimitSpec = {concurrency: 8, minIntervalMs: 0}

/**
 * Where one package costs several requests at once: the old Go registrar asked for 8 version
 * dates per module and the old NuGet one fetched every catalogue page together, 8 packages each.
 */
const DEFAULT_LIMITS_BY_TYPE: Readonly<Record<string, LimitSpec>> = {
    golang: {concurrency: 64, minIntervalMs: 0},
    nuget: {concurrency: 32, minIntervalMs: 0},
}

export interface RegistryLimits {
    /** What core's HTTP clients are built with. */
    limits: EcosystemLimits
    /** The ecosystems the user set, so a raised limit can also raise the packages looked up at once. */
    overrides: Readonly<Record<string, LimitSpec>>
}

export interface RegistryLimitsSources {
    /** `--registry-limits`, applied over the env variable. */
    flag?: string
    /** `DEPINDER_REGISTRY_LIMITS`. */
    env?: string
}

/** The defaults with the env variable's entries over them, and the flag's over both. */
export function resolveRegistryLimits(sources: RegistryLimitsSources): RegistryLimits {
    const overrides = {
        ...parseRegistryLimits(sources.env, REGISTRY_LIMITS_ENV),
        ...parseRegistryLimits(sources.flag, '--registry-limits'),
    }
    return {
        limits: {byType: {...DEFAULT_LIMITS_BY_TYPE, ...overrides}, fallback: DEFAULT_LIMIT},
        overrides,
    }
}

/** How many of one ecosystem's dependencies `analyse` looks up at once. */
export function packagesAtOnce(limits: RegistryLimits, type: string): number {
    return Math.max(DEFAULT_PACKAGES_AT_ONCE, limits.overrides[type]?.concurrency ?? 0)
}

const ENTRY = /^([a-z]+)=(\d+)(?::(\d+))?$/

/**
 * Reads `npm=16,maven=4,cargo=1:1000`: purl type, requests at once, and optionally the minimum
 * milliseconds between two request starts. Throws a message naming `source` on any bad entry.
 */
export function parseRegistryLimits(spec: string | undefined, source: string): Record<string, LimitSpec> {
    const parsed: Record<string, LimitSpec> = {}
    if (!spec?.trim()) return parsed
    for (const raw of spec.split(',')) {
        const entry = raw.trim().toLowerCase()
        const match = ENTRY.exec(entry)
        if (!match) throw invalid(source, raw, 'expected <type>=<concurrency>[:<minIntervalMs>]')
        const [, type, concurrency, interval] = match
        if (!isSupportedType(type)) throw invalid(source, raw, `unknown type "${type}"`)
        if (Number(concurrency) < 1) throw invalid(source, raw, 'concurrency must be at least 1')
        parsed[type] = {concurrency: Number(concurrency), minIntervalMs: Number(interval ?? 0)}
    }
    return parsed
}

function invalid(source: string, entry: string, reason: string): Error {
    return new Error(`Invalid registry limit "${entry.trim()}" in ${source}: ${reason}. `
        + `Example: npm=16,maven=4,cargo=1:1000. Types: ${SUPPORTED_TYPES.join(', ')}`)
}
