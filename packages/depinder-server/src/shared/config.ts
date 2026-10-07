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
    const portRaw = str(env.PORT) ?? '8080'
    const port = Number(portRaw)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`PORT must be an integer between 1 and 65535 (got "${portRaw}").`)
    }
    return port
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
