import type {PackageKeyer} from '@depinder/core'

/**
 * Ties a scanner finding to the purl that was sent, by the component's `bom-ref` (`c<index>`, see
 * `sbom.ts`). Both tools echo it (Trivy `PkgIdentifier.BOMRef`, Grype `artifact.id`), so the ref IS
 * the package. The purls they echo are their own spelling: Trivy lowercases a golang path and
 * spells a maven name `group:artifact`, Grype gives the bare artifactId.
 *
 * `refs` maps each ref to the purl as sent. `purlRefs` maps each component's SBOM purl to its ref:
 * an exact-purl safety net for a finding whose echoed ref is not one of ours (verified with Grype
 * 0.118 / Trivy 0.74 to never be needed). A finding that maps to neither is unmapped.
 */
export function bomRefKeyer(refs: ReadonlyMap<string, string>, purlRefs?: ReadonlyMap<string, string>): PackageKeyer {
    return scanned => {
        const fallback = scanned.purl !== undefined ? purlRefs?.get(scanned.purl) : undefined
        const ref = [scanned.ref, fallback].find(it => it !== undefined && refs.has(it))
        return ref === undefined ? undefined : {mergeKey: ref, indexKeys: [refs.get(ref)!]}
    }
}
