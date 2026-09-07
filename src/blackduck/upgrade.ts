import {ExportComponent} from './model'

/**
 * `_upgrade_guidance.csv`: the two versions Black Duck recommends for a vulnerable component.
 *
 *   Short Term — the LOWEST version at or above the current one that clears every finding.
 *                The smallest change that fixes the problem.
 *   Long  Term — the HIGHEST version that clears every finding. Where you would end up anyway.
 *
 * "Clears a finding" is decided from data already in the model — the registry version list the
 * analysis fetched and each finding's `firstPatchedVersion` — so no network call is made here.
 *
 * The rule is deliberately conservative: a finding is cleared by a candidate version only when
 * the source NAMED a first patched version and the candidate is at or above it. A finding with no
 * named fix clears nothing, so a component carrying one gets no recommendation at all and its row
 * is written with empty version columns — which is exactly what Black Duck does for the same case
 * (`adm-zip 0.6.0` in the reference export). The alternative, testing candidates against the
 * finding's `vulnerableRange`, is not available: for scanner findings that field is often the
 * degenerate `=<installed version>` local-scan falls back to, and every other version would then
 * "clear" the finding by construction.
 */

export interface UpgradeGuidance {
    component: ExportComponent
    shortTerm?: string
    longTerm?: string
}

function clears(component: ExportComponent, candidate: string): boolean {
    return component.vulnerabilities.every(it =>
        !!it.firstPatchedVersion && component.compare(candidate, it.firstPatchedVersion) >= 0)
}

/** Guidance for every component with at least one finding, in the model's component order. */
export function upgradeGuidance(components: ExportComponent[]): UpgradeGuidance[] {
    return components
        .filter(it => it.vulnerabilities.length > 0)
        .map(component => {
            // `registryVersions` is already ordered ascending by the ecosystem's comparator.
            const clean = component.registryVersions.filter(it => clears(component, it))
            const atOrAbove = clean.filter(it => component.compare(it, component.version) >= 0)
            return {
                component,
                shortTerm: atOrAbove[0],
                longTerm: clean[clean.length - 1],
            }
        })
}
