import fs from 'fs'
import path from 'path'
import {errorMessage} from '@depinder/core'
import {EnrichmentSummary} from './enrichment-report'
import {log} from '../utils/logging'

/** Final log footer from saved per-source summaries; never recount packages. */
export function logEnrichmentSummaries(resultFolders: readonly string[]): void {
    if (resultFolders.length === 0) return
    log.info('Final metadata summary:')
    for (const folder of resultFolders) {
        const summaryFile = path.join(folder, 'summary.json')
        try {
            const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as EnrichmentSummary
            const {detected, resolved, unresolved, skipped} = summary.totals
            log[unresolved > 0 ? 'warn' : 'info'](`Metadata completeness (${summary.source}): ${detected} detected, ${resolved} resolved, ${unresolved} unresolved, ${skipped} skipped (unique ecosystem/name/version)`)
            log.info(`  Summary: ${summaryFile}`)
            if (unresolved > 0) log.warn(`  Check unresolved packages: ${path.join(folder, 'unresolved-packages.csv')}`)
        } catch (e: any) {
            log.warn(`Could not read metadata summary ${summaryFile}: ${errorMessage(e)}`)
        }
    }
}
