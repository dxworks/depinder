// File-size rules for new and moved code (NX_MIGRATION.md D10). Files that were already too long
// when the guard arrived are in size-baseline.json and may shrink but never grow.

export const LIMITS = {
    code: {soft: 350, hard: 400},
    test: {soft: 500, hard: 550},
} as const

export type FileKind = keyof typeof LIMITS

const CODE_EXTENSIONS = /\.(ts|mts|cts|js|mjs|cjs)$/
const FIXTURE_PATH = /(^|\/)(fixtures|__fixtures__)\/|\.fixture\.[a-z]+$/
const TEST_PATH = /(^|\/)__tests__\/|\.(test|spec)\.[a-z]+$/

/** null for files the guard does not measure: non-code, declarations, fixtures. */
export function classify(path: string): FileKind | null {
    if (!CODE_EXTENSIONS.test(path) || path.endsWith('.d.ts') || FIXTURE_PATH.test(path)) return null
    return TEST_PATH.test(path) ? 'test' : 'code'
}

export interface Baseline {
    /** Repo-relative path → its line count when the guard arrived. */
    files: Record<string, number>
    /** Files holding functions over the function limit when the guard arrived; lint only warns there. */
    longFunctions: string[]
}

export interface SizeReport {
    errors: string[]
    warnings: string[]
}

export function checkSizes(lineCounts: Record<string, number>, baseline: Baseline): SizeReport {
    const report: SizeReport = {errors: [], warnings: []}
    for (const [path, lines] of Object.entries(lineCounts)) {
        const kind = classify(path)
        if (!kind) continue
        const {soft, hard} = LIMITS[kind]
        const allowed = baseline.files[path]
        if (allowed !== undefined) {
            if (lines > allowed) report.errors.push(`${path}: ${lines} lines, grew past its baseline of ${allowed}`)
        } else if (lines > hard) {
            report.errors.push(`${path}: ${lines} lines, over the ${kind} limit of ${hard}`)
        } else if (lines > soft) {
            report.warnings.push(`${path}: ${lines} lines, over the ${kind} target of ${soft}`)
        }
    }
    for (const path of Object.keys(baseline.files)) {
        if (!(path in lineCounts)) report.warnings.push(`${path}: in the baseline but gone; remove it from size-baseline.json`)
    }
    return report
}

export function countLines(text: string): number {
    if (text.length === 0) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}
