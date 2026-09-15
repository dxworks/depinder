import {Vulnerability} from '../extension-points/vulnerability-checker'
import {isPrerelease, majorOf, tokenizeVersion} from '../vuln-sources/github/versions'
import {ExportComponent} from './model'

/**
 * `_upgrade_guidance.csv`: the two versions Black Duck recommends for a vulnerable component.
 *
 *   Short Term — the HIGHEST stable version on the component's CURRENT LINE (same major) that
 *                clears every fixable finding: every patch you are entitled to without a breaking
 *                change. When the current line has no clean version, the lowest clean version
 *                above the current one — the smallest jump that fixes the problem.
 *   Long  Term — the HIGHEST stable version that clears every fixable finding. Where you would
 *                end up anyway.
 *
 * Both rules were read off the reference export (`zzy-v050-split-output`) against our own registry
 * lists: 127 of the 136 Short Term cells that could be tested were exactly the newest stable
 * same-major version, and 148 of 153 Long Term cells the newest stable overall; the rest were
 * versions published after Black Duck's Knowledge Base snapshot. The previous rule — the LOWEST
 * fix at or above the current version — disagreed with Black Duck on 148 of 191 rows.
 *
 * "Clears a finding" is decided from data already in the model — the registry version list the
 * analysis fetched and each finding's `patchedVersions` — so no network call is made here. A
 * source names one fix per maintained line (`2.15.0, 2.12.2`), and a candidate is fixed by the fix
 * of ITS line: 2.12.5 is clean, 2.13.0 is not, although 2.13.0 > 2.12.2 (see `fixedBy`). Reading
 * only the first fix, as the previous rule did, pushed 47 recommendations across a major although
 * the current line had a fix — Trivy lists the newest line first.
 *
 * A finding with no named fix cannot be cleared by any version, so it is left out of the choice
 * and counted in the recommendation's remaining-vulnerability columns instead — Black Duck
 * recommends `dompurify 3.4.15` with one of twenty findings unfixed rather than nothing. A
 * component whose findings are ALL unfixed gets no recommendation and an empty row, which is what
 * Black Duck writes for the same case (`adm-zip 0.6.0` in the reference export).
 *
 * Pre-releases are never recommended while a stable candidate exists: Black Duck wrote 4 of 288
 * Short Term cells as pre-releases, we wrote 26 Long Term ones (`27.0.0-alpha.8`). They remain the
 * fallback when nothing stable clears the findings.
 */

export interface UpgradeGuidance {
    component: ExportComponent
    shortTerm?: string
    longTerm?: string
}

function fixesOf(finding: Vulnerability): string[] {
    if (finding.patchedVersions?.length) return finding.patchedVersions
    return finding.firstPatchedVersion ? [finding.firstPatchedVersion] : []
}

/**
 * The leading numeric segments that tell the named fixes apart: `2.15.0, 2.12.2` are told apart by
 * their second segment, `2.5.8, 3.2.4` by their first, a single fix by its first. A candidate is
 * on a fix's line when it agrees with it on those segments.
 */
function lineDepth(fixes: string[]): number {
    const prefixes = fixes.map(numericPrefix)
    let depth = 0
    while (prefixes.every(it => it.length > depth && it[depth] === prefixes[0][depth])) depth++
    return depth + 1
}

function numericPrefix(version: string): number[] {
    const prefix: number[] = []
    for (const token of tokenizeVersion(version)) {
        if (token.kind !== 'num') break
        prefix.push(token.value)
    }
    return prefix
}

function lineOf(version: string, depth: number): string {
    return numericPrefix(version).slice(0, depth).join('.')
}

/**
 * Whether `candidate` carries the fix for `finding`. A candidate on a line that has a named fix
 * is fixed at or above that fix; a candidate on a line with no fix of its own is fixed only above
 * EVERY named fix — `2.13.0` sits between the `2.12.2` backport and the `2.15.0` fix and is
 * vulnerable, `4.0.0` is above both and is not.
 */
export function fixedBy(component: ExportComponent, finding: Vulnerability, candidate: string): boolean {
    const fixes = fixesOf(finding)
    if (fixes.length === 0) return false
    const depth = lineDepth(fixes)
    const ownFix = fixes.find(fix => lineOf(fix, depth) === lineOf(candidate, depth))
    if (ownFix !== undefined) return component.compare(candidate, ownFix) >= 0
    return fixes.every(fix => component.compare(candidate, fix) > 0)
}

/** The findings a component would still carry at `version` — what the severity columns count. */
export function remainingAt(component: ExportComponent, version: string): Vulnerability[] {
    return component.vulnerabilities.filter(it => !fixedBy(component, it, version))
}

/** Guidance for every component with at least one finding, in the model's component order. */
export function upgradeGuidance(components: ExportComponent[]): UpgradeGuidance[] {
    return components
        .filter(it => it.vulnerabilities.length > 0)
        .map(component => {
            const fixable = component.vulnerabilities.filter(it => fixesOf(it).length > 0)
            if (fixable.length === 0) return {component}

            // `registryVersions` is already ordered ascending by the ecosystem's comparator.
            const clean = component.registryVersions.filter(candidate =>
                component.compare(candidate, component.version) >= 0
                && fixable.every(finding => fixedBy(component, finding, candidate)))
            const stable = clean.filter(it => !isPrerelease(it))
            const pool = stable.length > 0 ? stable : clean
            const currentMajor = majorOf(component.version)
            const sameLine = pool.filter(it => majorOf(it) === currentMajor)
            return {
                component,
                shortTerm: sameLine.length > 0 ? sameLine[sameLine.length - 1] : pool[0],
                longTerm: pool[pool.length - 1],
            }
        })
}
