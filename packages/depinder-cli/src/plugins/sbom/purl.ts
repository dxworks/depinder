import {canonicalPurl, fromRegistryName, registryName, splitPurl, type PurlParts} from '@depinder/core'

/**
 * The SBOM side of purls: what Syft and Trivy write, turned into the one spelling depinder keys
 * dependencies by. Parsing and canonicalisation (case folding, PEP 503) are core's; only the rules
 * that come from the SBOM tools live here:
 *
 *  - Trivy lowercases golang module paths in the purl (`pkg:golang/github.com/masterminds/semver/v3`)
 *    while keeping the real case in the component `name`; Syft keeps `Masterminds` in both. On
 *    the zzw-v051 mined SBOMs this is the only spelling difference between the two tools.
 *  - Syft writes a versionless purl, with `version: 'UNKNOWN'` on the component, for what it could
 *    not pin: nuget local projects, npm workspace packages, the gradle wrapper.
 *  - Qualifiers and subpaths are dropped. Syft's `?package-id=` lives in the `bom-ref` only, and a
 *    purl with it would never match the other tool's.
 *  - Every segment is percent-encoded the way both tools write it (`pkg:npm/%40babel/core@7.24.0`,
 *    `pkg:cargo/wasi@0.14.2%2Bwasi-0.2.4`), so a purl that needed no fixing stays byte for byte as
 *    written. The servers read this spelling and core's `@`-keeping key form alike.
 */

export interface PurlComponent {
    name?: string
    group?: string
    version?: string
}

/** A purl reduced to what depinder's model needs; `name` is the registry form (`registryName`). */
export interface PurlCoordinates {
    type: string
    name: string
    version: string
}

/**
 * The normalised purl — `pkg:type/namespace/name@version`, never with qualifiers or a subpath —
 * or undefined for anything that is not a usable purl.
 *
 * The version is kept verbatim (a golang `v0.25.1` keeps its `v`). A purl without one takes the
 * component's own `version`; when neither knows the version the result is versionless
 * (`pkg:maven/org.apache.zeppelin/zeppelin-interpreter`), never `@UNKNOWN`, which no registry has.
 */
export function normalizePurl(purl: string | undefined, component?: PurlComponent): string | undefined {
    const parts = purl?.startsWith('pkg:') ? splitOrUndefined(purl) : undefined
    if (!parts) return undefined
    const version = knownVersion(parts.version) ?? knownVersion(component?.version)
    try {
        return spellPurl(canonicalPurl(golangCase(parts, component)), version)
    } catch {
        return undefined
    }
}

/**
 * The (type, registry name, version) a purl names, with the names as written. Undefined for
 * anything unparseable or versionless, rather than a guess.
 */
export function purlCoordinates(purl: string): PurlCoordinates | undefined {
    const parts = splitOrUndefined(purl)
    const version = parts?.version?.trim()
    if (!parts || !version) return undefined
    if (parts.type === 'maven' && !parts.namespace) return undefined
    return {type: parts.type, name: registryName(parts), version}
}

/**
 * The purl for a dependency whose SBOM component had none that parsed, spelled from its registry
 * name the way `normalizePurl` spells a parsed one. Undefined when the name is not one of `type`.
 */
export function purlFromRegistryName(type: string, name: string, version: string): string | undefined {
    try {
        return spellPurl(fromRegistryName(type, name), version)
    } catch {
        return undefined
    }
}

function splitOrUndefined(purl: string): PurlParts | undefined {
    try {
        return splitPurl(purl)
    } catch {
        return undefined
    }
}

/** `UNKNOWN` is Syft's word for no version. */
function knownVersion(version: string | null | undefined): string | undefined {
    const trimmed = version?.trim()
    return trimmed && trimmed.toUpperCase() !== 'UNKNOWN' ? trimmed : undefined
}

/**
 * Golang module paths are case-sensitive, but Trivy lowercases them in the purl. Its component
 * `name` keeps the full path in the original case (`github.com/Masterminds/semver/v3`, no `group`),
 * so when the name spells the same path ignoring case, the name's spelling wins — which makes
 * Trivy's purl equal to Syft's. A name that is a different path is ignored.
 */
function golangCase(parts: PurlParts, component?: PurlComponent): PurlParts {
    if (parts.type !== 'golang' || !component?.name) return parts
    const spelled = component.group ? `${component.group}/${component.name}` : component.name
    const path = registryName(parts)
    if (spelled === path || spelled.toLowerCase() !== path.toLowerCase()) return parts
    const slash = spelled.lastIndexOf('/')
    return {...parts, namespace: slash > 0 ? spelled.slice(0, slash) : null, name: spelled.slice(slash + 1)}
}

function spellPurl(parsed: {type: string, namespace: string | null, name: string}, version: string | undefined): string {
    const segments = [...(parsed.namespace?.split('/') ?? []), parsed.name].filter(it => it.length > 0)
    const key = `pkg:${parsed.type}/${segments.map(encodeURIComponent).join('/')}`
    return version ? `${key}@${encodeURIComponent(version)}` : key
}
