import {localScanOutcome, LocalScanOutcome} from '../src/plugins/sbom/scan-outcomes'
import type {ScannedFileRecord} from '../src/plugins/sbom/scan-provenance'
import {parseVulnSources} from '../src/vuln-sources/selection'

/**
 * localScanOutcome: the verdict behind the final summary line and the provenance file, as a
 * table of representative selection/token/per-file outcomes. Message wording for each verdict
 * lives in sbom.scanner-outcomes.test.ts.
 */

interface Scenario {
    name: string
    selection: string
    hasGithubToken: boolean
    files: Pick<ScannedFileRecord, 'trivy' | 'grype'>[]
    expected: LocalScanOutcome
}

describe('localScanOutcome classifies selected scanner reports', () => {
    it.each([
        {
            name: 'the one selected scanner scanning every file is complete',
            selection: 'trivy', hasGithubToken: false,
            files: [{trivy: 'ok', grype: 'skipped'}, {trivy: 'ok', grype: 'skipped'}],
            expected: {
                requested: ['trivy'], successful: ['trivy'], incomplete: [],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'complete',
            },
        },
        {
            name: 'grype alone scanning its file is complete',
            selection: 'grype', hasGithubToken: false,
            files: [{trivy: 'skipped', grype: 'ok'}],
            expected: {
                requested: ['grype'], successful: ['grype'], incomplete: [],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'complete',
            },
        },
        {
            name: 'both selected scanners ok on every file is complete',
            selection: 'trivy,grype', hasGithubToken: false,
            files: [{trivy: 'ok', grype: 'ok'}, {trivy: 'ok', grype: 'ok'}],
            expected: {
                requested: ['trivy', 'grype'], successful: ['trivy', 'grype'], incomplete: [],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'complete',
            },
        },
        {
            name: 'a token does not imply fallback after a local success',
            selection: 'trivy,grype', hasGithubToken: true,
            files: [{trivy: 'ok', grype: 'skipped'}],
            expected: {
                requested: ['trivy', 'grype'], successful: ['trivy'], incomplete: ['grype'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'partial',
            },
        },
        {
            name: 'the selected scanner succeeding on one file only is partial',
            selection: 'trivy', hasGithubToken: false,
            files: [{trivy: 'ok', grype: 'skipped'}, {trivy: 'skipped', grype: 'skipped'}],
            expected: {
                requested: ['trivy'], successful: ['trivy'], incomplete: ['trivy'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'partial',
            },
        },
        {
            name: 'success distributed across files is not complete',
            selection: 'trivy,grype', hasGithubToken: false,
            files: [{trivy: 'ok', grype: 'skipped'}, {trivy: 'skipped', grype: 'ok'}],
            expected: {
                requested: ['trivy', 'grype'], successful: ['trivy', 'grype'], incomplete: ['trivy', 'grype'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'partial',
            },
        },
        {
            name: 'every selected scanner skipped is disabled without a token',
            selection: 'trivy,grype', hasGithubToken: false,
            files: [{trivy: 'skipped', grype: 'skipped'}],
            expected: {
                requested: ['trivy', 'grype'], successful: [], incomplete: ['trivy', 'grype'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'disabled',
            },
        },
        {
            name: 'no files is never vacuously complete',
            selection: 'trivy', hasGithubToken: false,
            files: [],
            expected: {
                requested: ['trivy'], successful: [], incomplete: ['trivy'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'disabled',
            },
        },
        {
            name: 'an unselected scanner\'s success is ignored',
            selection: 'trivy', hasGithubToken: false,
            files: [{trivy: 'skipped', grype: 'ok'}],
            expected: {
                requested: ['trivy'], successful: [], incomplete: ['trivy'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'disabled',
            },
        },
        {
            name: 'a token with no reports is the advisory fallback',
            selection: 'trivy', hasGithubToken: true,
            files: [{trivy: 'skipped', grype: 'skipped'}],
            expected: {
                requested: ['trivy'], successful: [], incomplete: ['trivy'],
                githubAdvisoryFallback: true, vulnerabilityAnalysis: 'github-advisories-only',
            },
        },
        {
            name: 'github-only selection requests no local scanners',
            selection: 'github', hasGithubToken: false,
            files: [{trivy: 'skipped', grype: 'skipped'}],
            expected: {
                requested: [], successful: [], incomplete: [],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'github-advisories-only',
            },
        },
        {
            name: 'github-only selection ignores local records; explicit is never fallback',
            selection: 'github', hasGithubToken: true,
            files: [{trivy: 'ok', grype: 'skipped'}],
            expected: {
                requested: [], successful: [], incomplete: [],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'github-advisories-only',
            },
        },
        {
            name: 'an explicit github selection with failed local scans is advisories, not fallback',
            selection: 'trivy,github', hasGithubToken: false,
            files: [{trivy: 'skipped', grype: 'skipped'}],
            expected: {
                requested: ['trivy'], successful: [], incomplete: ['trivy'],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'github-advisories-only',
            },
        },
        {
            name: 'a successful selected scan stays complete when github is also selected',
            selection: 'trivy,github', hasGithubToken: true,
            files: [{trivy: 'ok', grype: 'skipped'}],
            expected: {
                requested: ['trivy'], successful: ['trivy'], incomplete: [],
                githubAdvisoryFallback: false, vulnerabilityAnalysis: 'complete',
            },
        },
    ] satisfies Scenario[])('$name', ({selection, hasGithubToken, files, expected}) => {
        expect(localScanOutcome(files, parseVulnSources(selection), hasGithubToken)).toEqual(expected)
    })
})
