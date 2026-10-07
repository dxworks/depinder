import type {CellChange} from './allowed-differences.js'

/**
 * Black Duck's `_upgrade_guidance.csv` recommends a short and a long term version per component.
 * A release after the reference run can become the new recommendation; the recommendation's
 * origin id, origin version and vulnerability counts then follow from that version.
 */

const UPGRADE_GUIDANCE_FILE = '_upgrade_guidance.csv'
const TERMS = ['Short Term', 'Long Term']

const versionColumnOf = (term: string) => `${term} Recommended Version Name`
/** The ecosystem of the recommendation, not something a newer version moves. */
const originNameColumnOf = (term: string) => `${term} Recommended Origin Name`

/** The recommended-version column that `column` follows, or undefined for any other column. */
export function recommendedVersionColumnOf(file: string, column: string): string | undefined {
    if (file !== UPGRADE_GUIDANCE_FILE) return undefined
    const term = TERMS.find(it => column.startsWith(`${it} `))
    return term && column !== originNameColumnOf(term) ? versionColumnOf(term) : undefined
}

/** The changed recommended-version columns whose new version `isNewRelease` accepts. */
export function newerRecommendations(file: string, changes: CellChange[], isNewRelease: (version: string) => boolean): Set<string> {
    const columns = new Set<string>()
    if (file !== UPGRADE_GUIDANCE_FILE) return columns
    for (const change of changes) {
        if (TERMS.some(term => change.column === versionColumnOf(term)) && isNewRelease(change.b)) columns.add(change.column)
    }
    return columns
}
