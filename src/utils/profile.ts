import http from 'http'
import https from 'https'
import {log} from './logging'

/**
 * A light profile of one run: wall-clock per phase, a few counters, and — when enabled — the
 * number of HTTP requests per host.
 *
 * Phases and counters are always collected; they cost a Map lookup each. The HTTP hook and the
 * summary line are switched on by `--profile` (or `DEPINDER_PROFILE=1`), so a normal run's output
 * is unchanged. Phase names are free-form; the same name accumulates, so a phase that runs once
 * per project or per file reports its total.
 */

const phases = new Map<string, number>()
const counters = new Map<string, number>()
let enabled = !!process.env.DEPINDER_PROFILE
let hooked = false

export function enableProfile(): void {
    enabled = true
    hookHttp()
}

export function profileEnabled(): boolean {
    return enabled
}

/** Runs `fn` and adds its wall-clock to `phase`. Exceptions propagate; the time still counts. */
export async function timePhase<T>(phase: string, fn: () => T | Promise<T>): Promise<T> {
    const started = Date.now()
    try {
        return await fn()
    } finally {
        phases.set(phase, (phases.get(phase) ?? 0) + Date.now() - started)
    }
}

/** The synchronous twin of `timePhase`, for parsers and writers that never await. */
export function timePhaseSync<T>(phase: string, fn: () => T): T {
    const started = Date.now()
    try {
        return fn()
    } finally {
        phases.set(phase, (phases.get(phase) ?? 0) + Date.now() - started)
    }
}

export function count(counter: string, by = 1): void {
    counters.set(counter, (counters.get(counter) ?? 0) + by)
}

/** Counts every outgoing HTTP(S) request by host, including retries and paginated calls. */
function hookHttp(): void {
    if (hooked) return
    hooked = true
    for (const mod of [http, https] as const) {
        const original = mod.request
        const counted = function (this: unknown, ...args: any[]) {
            const first = args[0]
            const host = typeof first === 'string' || first instanceof URL
                ? new URL(String(first)).host
                : first?.host ?? first?.hostname ?? 'unknown'
            count(`http:${host}`)
            return (original as any).apply(this, args)
        }
        // `https.get` calls the module-internal `request`, so both entry points need the hook.
        ;(mod as any).request = counted
        ;(mod as any).get = function (this: unknown, ...args: any[]) {
            const req = (counted as any).apply(this, args)
            req.end()
            return req
        }
    }
}

export function profileLines(): string[] {
    const lines: string[] = []
    const totalMs = [...phases.values()].reduce((a, b) => a + b, 0)
    for (const [phase, ms] of phases) {
        lines.push(`  ${(ms / 1000).toFixed(1).padStart(8)}s  ${phase}`)
    }
    lines.push(`  ${(totalMs / 1000).toFixed(1).padStart(8)}s  (sum of phases)`)
    for (const [counter, n] of [...counters].sort()) {
        lines.push(`  ${String(n).padStart(9)}  ${counter}`)
    }
    return lines
}

/** Logs the summary, when profiling is on. Safe to call unconditionally at the end of a run. */
export function logProfile(): void {
    if (!enabled) return
    log.info(['Profile:', ...profileLines()].join('\n'))
}

/** For tests. */
export function resetProfile(): void {
    phases.clear()
    counters.clear()
}
