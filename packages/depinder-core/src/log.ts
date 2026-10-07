/**
 * One-line JSON logging on stdout. Small on purpose: the service has a handful of call sites and
 * no need for transports, serialisers or redaction, so a logging library would be one more
 * dependency to keep current for no gain.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<LogLevel, number> = {debug: 10, info: 20, warn: 30, error: 40}

export interface Logger {
    debug(msg: string, fields?: Record<string, unknown>): void
    info(msg: string, fields?: Record<string, unknown>): void
    warn(msg: string, fields?: Record<string, unknown>): void
    error(msg: string, fields?: Record<string, unknown>): void
    child(bindings: Record<string, unknown>): Logger
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
    const threshold = ORDER[level] ?? ORDER.info

    function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>): void {
        if (ORDER[lvl] < threshold) return
        const line = {time: new Date().toISOString(), level: lvl, msg, ...bindings, ...fields}
        process.stdout.write(JSON.stringify(line, replacer) + '\n')
    }

    return {
        debug: (m, f) => emit('debug', m, f),
        info: (m, f) => emit('info', m, f),
        warn: (m, f) => emit('warn', m, f),
        error: (m, f) => emit('error', m, f),
        child: extra => createLogger(level, {...bindings, ...extra}),
    }
}

function replacer(_key: string, value: unknown): unknown {
    if (value instanceof Error) return {name: value.name, message: value.message, stack: value.stack}
    return value
}

/** A logger that drops everything. Handy in tests. */
export const nullLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => nullLogger,
}

/** `String(e)` on an unknown catch value, without the `[object Object]` surprises. */
export function errorMessage(e: unknown): string {
    if (e instanceof Error) return e.message || e.name
    if (typeof e === 'string') return e
    try {
        return JSON.stringify(e)
    } catch {
        return String(e)
    }
}
