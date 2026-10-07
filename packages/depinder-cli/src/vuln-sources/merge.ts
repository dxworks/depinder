import {Vulnerability} from '../extension-points/vulnerability-checker'

/**
 * Unioning the findings of two sources over the same package keys.
 *
 * Sources disagree about which identifier is primary: Trivy reports a CVE and lists the GHSA as a
 * vendor id, Grype reports the GHSA, and this source reports the GHSA with the CVE as an alias. So
 * two findings are the same finding when they share ANY identifier — matching on the primary id
 * alone would double-count every advisory that has both.
 */

function identifierSet(vulnerability: Vulnerability): Set<string> {
    const ids = (vulnerability.identifiers ?? []).map(it => it.value.toUpperCase())
    return new Set(ids)
}

function sameFinding(a: Vulnerability, b: Vulnerability): boolean {
    const left = identifierSet(a)
    for (const id of identifierSet(b)) if (left.has(id)) return true
    return false
}

/**
 * Adds `incoming` into `base`, in place, keeping the base's version of any finding both sources
 * report and recording that both saw it. The base is the authority because it is the source the
 * run listed first, and because rewriting a finding a scanner already matched exactly would be a
 * downgrade — the merge only ever adds.
 */
export function mergeVulnerabilityIndexes(
    base: Map<string, Vulnerability[]>,
    incoming: Map<string, Vulnerability[]>
): Map<string, Vulnerability[]> {
    for (const [key, findings] of incoming) {
        const existing = base.get(key)
        if (!existing) {
            base.set(key, [...findings])
            continue
        }
        for (const finding of findings) {
            const duplicate = existing.find(it => sameFinding(it, finding))
            if (!duplicate) {
                existing.push(finding)
                continue
            }
            if (finding.source && !duplicate.source?.split(',').includes(finding.source)) {
                duplicate.source = duplicate.source ? `${duplicate.source},${finding.source}` : finding.source
            }
        }
    }
    return base
}
