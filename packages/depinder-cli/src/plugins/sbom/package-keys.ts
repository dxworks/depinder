import type {PackageKeyer} from '@depinder/core'
import {purlCoordinates} from './purl'

/**
 * All the keys under which one scanned package is findable, plus the canonical key used to
 * deduplicate findings across tools. Both tools echo the SBOM's purl, so after normalization the
 * two tools' findings for the same package land on the same keys:
 *  - the purl stripped of qualifiers/subpath (Syft purls carry a `package-id` qualifier)
 *  - `name@version` with the name in depinder's registry form (maven `groupId:artifactId`,
 *    npm `@scope/name`): DepinderDependency.id, the key the sbom parser looks up.
 *  - the tool's own name@version, for robustness (Grype's artifact.name is the BARE maven
 *    artifactId, so this key differs per tool and is never the dedup key when a purl parses).
 */
export function packageKeys(purl: string | undefined, name?: string, version?: string): {keys: string[], dedupKey?: string} {
    const keys: string[] = []
    let dedupKey: string | undefined
    if (purl) {
        keys.push(purl.split('?')[0].split('#')[0])
        const parsed = purlCoordinates(purl)
        if (parsed) {
            dedupKey = `${parsed.name}@${parsed.version}`
            keys.push(dedupKey)
        }
    }
    if (name && version) {
        const key = `${name}@${version}`
        if (!keys.includes(key)) keys.push(key)
        dedupKey = dedupKey ?? key
    }
    dedupKey = dedupKey ?? keys[0]
    return {keys, dedupKey}
}

/** Merges a real SBOM's findings by the purl-derived name@version and indexes them under every key. */
export const sbomPackageKeyer: PackageKeyer = scanned => {
    const {keys, dedupKey} = packageKeys(scanned.purl, scanned.name, scanned.version)
    return keys.length > 0 ? {mergeKey: dedupKey ?? keys[0], indexKeys: keys} : undefined
}
