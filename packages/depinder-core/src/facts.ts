/**
 * Settings that change the facts rather than the speed. Each has one fixed value, the same for the
 * CLI and the server (D17), so the two can never answer differently because of how they were set
 * up. Speed settings (limits, timeouts, concurrency) belong to each caller.
 */

/**
 * Read a POM per maven version for that version's own licenses. Off: every version carries the
 * library-level licenses, which costs three requests per artifact instead of one per version.
 */
export const MAVEN_PER_VERSION_LICENSES = false
