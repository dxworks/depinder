import type {MockInstance} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {logEnrichmentSummaries} from '../src/commands/enrichment-summary'
import {EnrichmentSummary, PackageCounts} from '../src/commands/enrichment-report'
import {log} from '../src/utils/logging'

const summaryJson = (source: string, totals: PackageCounts): EnrichmentSummary => ({
    schemaVersion: 1,
    source,
    countingUnit: 'ecosystem+name+version',
    scope: 'dependencies parsed by selected plugins',
    totals,
    ecosystems: {npm: totals},
})

const writeSummary = (folder: string, source: string, totals: PackageCounts): void => {
    fs.mkdirSync(folder, {recursive: true})
    fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(summaryJson(source, totals), null, 2))
}

const line = (source: string, detected: number, resolved: number, unresolved: number, skipped: number) =>
    `Metadata completeness (${source}): ${detected} detected, ${resolved} resolved, ${unresolved} unresolved, ${skipped} skipped (unique ecosystem/name/version)`

describe('the final metadata summary', () => {
    let tmp: string
    let messages: {level: string, text: string}[]
    let info: MockInstance
    let warn: MockInstance

    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'depinder-summary-'))
        messages = []
        info = vi.spyOn(log, 'info').mockImplementation(((text: string) => {
            messages.push({level: 'info', text})
            return log
        }) as any)
        warn = vi.spyOn(log, 'warn').mockImplementation(((text: string) => {
            messages.push({level: 'warn', text})
            return log
        }) as any)
    })
    afterEach(() => {
        info.mockRestore()
        warn.mockRestore()
        fs.rmSync(tmp, {recursive: true, force: true})
    })

    it('repeats each source\'s saved counts, flagging unresolved CSVs only where they exist', () => {
        const trivyFolder = path.join(tmp, 'results', 'trivy')
        const syftFolder = path.join(tmp, 'results', 'syft')
        writeSummary(trivyFolder, 'trivy', {detected: 3, resolved: 2, unresolved: 1, skipped: 0})
        writeSummary(syftFolder, 'syft', {detected: 2, resolved: 2, unresolved: 0, skipped: 0})

        logEnrichmentSummaries([trivyFolder, syftFolder])

        // The unresolved CSV itself need not exist for the footer to name it.
        expect(messages).toEqual([
            {level: 'info', text: 'Final metadata summary:'},
            {level: 'warn', text: line('trivy', 3, 2, 1, 0)},
            {level: 'info', text: `  Summary: ${path.join(trivyFolder, 'summary.json')}`},
            {level: 'warn', text: `  Check unresolved packages: ${path.join(trivyFolder, 'unresolved-packages.csv')}`},
            {level: 'info', text: line('syft', 2, 2, 0, 0)},
            {level: 'info', text: `  Summary: ${path.join(syftFolder, 'summary.json')}`},
        ])
    })

    it('says nothing when the run had no source folders', () => {
        logEnrichmentSummaries([])

        expect(messages).toEqual([])
    })

    it.each([
        {state: 'missing', contents: undefined},
        {state: 'corrupt', contents: '{corrupt'},
    ])('warns on a $state summary file and still renders the other sources', ({contents}) => {
        const unavailableFolder = path.join(tmp, 'results', 'trivy')
        const syftFolder = path.join(tmp, 'results', 'syft')
        fs.mkdirSync(unavailableFolder, {recursive: true})
        if (contents !== undefined) {
            fs.writeFileSync(path.join(unavailableFolder, 'summary.json'), contents)
        }
        writeSummary(syftFolder, 'syft', {detected: 2, resolved: 2, unresolved: 0, skipped: 0})

        logEnrichmentSummaries([unavailableFolder, syftFolder])

        expect(messages[0]).toEqual({level: 'info', text: 'Final metadata summary:'})
        expect(messages[1].level).toBe('warn')
        expect(messages[1].text).toContain(`Could not read metadata summary ${path.join(unavailableFolder, 'summary.json')}`)
        expect(messages.slice(2)).toEqual([
            {level: 'info', text: line('syft', 2, 2, 0, 0)},
            {level: 'info', text: `  Summary: ${path.join(syftFolder, 'summary.json')}`},
        ])
    })
})
