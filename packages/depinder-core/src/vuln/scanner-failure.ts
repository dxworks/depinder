/** A failed scanner run: a headline (an `execFile` error message, or `exit 1`) and the child's stderr. */
export interface ScannerFailure {
    message?: string
    stderr?: string
}

const ANSI_COLOUR = /\x1b\[[0-9;]*m/g
const VERDICT_WORDS = /error|fatal|failed|denied/i

/**
 * Why a scanner call failed, in one line, with the scanner's own last word kept.
 *
 * The headline alone (`Command failed: trivy sbom …`, `exit 1`) names the failure and never the
 * reason: an expired database the scanner could not re-download reads exactly like a corrupt SBOM.
 * The last stderr line that mentions a failure is the one the scanner meant as its verdict; without
 * one, the last line. Grype colours its log lines, so the escapes are dropped.
 */
export function scannerFailureReason(failure: ScannerFailure): string {
    const head = `${failure.message ?? ''}`.split('\n')[0]
    const lines = `${failure.stderr ?? ''}`.replace(ANSI_COLOUR, '').split('\n')
        .map(it => it.trim())
        .filter(Boolean)
    const detail = [...lines].reverse().find(it => VERDICT_WORDS.test(it)) ?? lines[lines.length - 1]
    return detail ? `${head} — ${detail}` : head
}
