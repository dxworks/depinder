import {log} from './logging'

/**
 * A light profile of one run: wall-clock per phase and a few counters, among them the HTTP
 * requests per host (`countRequest`).
 *
 * Phases and counters are always collected; they cost a Map lookup each. The summary is switched
 * on by `--profile` (or `DEPINDER_PROFILE=1`), so a normal run's output is unchanged. Phase names
 * are free-form; the same name accumulates, so a phase that runs once per project or per file
 * reports its total.
 */

const phases = new Map<string, number>()
const counters = new Map<string, number>()
let enabled = !!process.env.DEPINDER_PROFILE

export function enableProfile(): void {
    enabled = true
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

/**
 * For a phase that spans a block too large to wrap in a callback: `const phase = startPhase(...)`,
 * then `phase.end()` when the block is done.
 */
export function startPhase(phase: string): {end: () => void} {
    const started = Date.now()
    return {end: () => phases.set(phase, (phases.get(phase) ?? 0) + Date.now() - started)}
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

/**
 * Counts one outgoing HTTP request under `http:<host>`. Every client calls it once per attempt, so
 * retries and paginated calls count too.
 */
export function countRequest(url: string): void {
    count(`http:${hostOf(url)}`)
}

function hostOf(url: string): string {
    try {
        return new URL(url).host
    } catch {
        return 'unknown'
    }
}

export function profileLines(): string[] {
    const lines: string[] = []
    const totalMs = [...phases.values()].reduce((a, b) => a + b, 0)
    for (const [phase, ms] of phases) {
        lines.push(`  ${(ms / 1000).toFixed(1).padStart(8)}s  ${phase}`)
    }
    // Phases overlap (plugins run side by side), so the sum is a cost, not a duration.
    lines.push(`  ${(totalMs / 1000).toFixed(1).padStart(8)}s  (sum of phases)`)
    lines.push(`  ${process.uptime().toFixed(1).padStart(8)}s  (wall clock since start)`)
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
