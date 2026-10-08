import type {LogLevel} from '@depinder/core'

/**
 * The environment parsing both roles share: the resolver's `loadConfig`
 * (`src/resolver/config.ts`) and `loadVulnConfig` (`src/vuln/config.ts`).
 */

export class ConfigError extends Error {}

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * `RESOLVER_API_TOKEN`: required, and long enough to be worth having. The resolver's `loadConfig`
 * and `loadVulnConfig` take the same token with the same checks.
 */
export function requireToken(env: NodeJS.ProcessEnv): string {
    const apiToken = str(env.RESOLVER_API_TOKEN)
    if (!apiToken) {
        throw new ConfigError(
            'RESOLVER_API_TOKEN is required. Every route except /health needs it as a bearer token. ' +
            'Generate one with: openssl rand -hex 32',
        )
    }
    if (apiToken.length < 16) {
        throw new ConfigError(
            `RESOLVER_API_TOKEN must be at least 16 characters (got ${apiToken.length}). ` +
            'Generate one with: openssl rand -hex 32',
        )
    }
    return apiToken
}

/** `LOG_LEVEL`, default `info`. Shared with `loadVulnConfig`. */
export function requireLogLevel(env: NodeJS.ProcessEnv): LogLevel {
    const logLevel = (str(env.LOG_LEVEL) ?? 'info') as LogLevel
    if (!LEVELS.includes(logLevel)) {
        throw new ConfigError(`LOG_LEVEL must be one of ${LEVELS.join(', ')} (got "${logLevel}").`)
    }
    return logLevel
}

/** `PORT`, default 8080. Shared with `loadVulnConfig`. */
export function requirePort(env: NodeJS.ProcessEnv): number {
    return int(env, 'PORT', 8080, 1, 65535)
}

/** The integer setting `name`, or `fallback` when unset; no `max` means no upper bound. */
export function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max?: number): number {
    const raw = str(env[name])
    if (raw === undefined) return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
        const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`
        throw new ConfigError(`${name} must be an integer ${range} (got "${raw}").`)
    }
    return value
}

/** Entry-point wrapper: a readable message on stderr and exit code 1 instead of a stack trace. */
export function loadConfigOrExit<T>(load: (env: NodeJS.ProcessEnv) => T, env = process.env): T {
    try {
        return load(env)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        process.stderr.write(`depinder-server-side: configuration error\n  ${msg}\n`)
        process.exit(1)
    }
}

export function str(v: string | undefined): string | undefined {
    const trimmed = v?.trim()
    return trimmed ? trimmed : undefined
}

export function bool(v: string | undefined, fallback: boolean): boolean {
    const s = str(v)?.toLowerCase()
    if (s === undefined) return fallback
    if (['1', 'true', 'yes', 'on'].includes(s)) return true
    if (['0', 'false', 'no', 'off'].includes(s)) return false
    return fallback
}
