/**
 * Normalises an SBOM component's purl into the one spelling depinder keys dependencies by.
 *
 * Syft and Trivy both write a purl for every package, and it is the only identifier either tool
 * gets right for every ecosystem — but the two do not always spell the same package the same way:
 *
 *  - Trivy lowercases golang module paths in the purl (`pkg:golang/github.com/masterminds/semver/v3`)
 *    while keeping the real case in the component `name`; Syft keeps `Masterminds` in both. On
 *    the zzw-v051 mined SBOMs this is the only spelling difference between the two tools: 8 of
 *    go-caddy's modules, against 13,351 purls that already match byte for byte.
 *  - Syft writes a versionless purl, with `version: 'UNKNOWN'` on the component, for what it could
 *    not pin: nuget local projects, npm workspace packages, the gradle wrapper.
 *  - Qualifiers and subpaths are dropped although neither tool writes them in `purl` today. Syft's
 *    `?package-id=` lives in the `bom-ref` only, which is exactly where it is easy to pick up by
 *    mistake — and a purl with it would never match the other tool's.
 *
 * The rules mirror the resolver server's canonicalisation (depinder-server-side `src/purl.ts`), so
 * the purl sent is already the key the server stores under: npm, composer and nuget names are
 * lowercased, pypi names are PEP 503-normalised, and maven, gem, golang and cargo — case-sensitive
 * upstream — are left as given. Unlike the server, `@` in an npm scope is written `%40`, which is
 * what both tools already emit (`pkg:npm/%40babel/core@7.24.0`); the server reads either spelling
 * to the same key.
 */

export interface PurlComponent {
    name?: string
    group?: string
    version?: string
}

/**
 * The normalised purl — `pkg:type/namespace/name@version`, never with qualifiers or a subpath —
 * or undefined for anything that is not a purl.
 *
 * The version is kept verbatim (a golang `v0.25.1` keeps its `v`). A purl without one takes the
 * component's own `version`; when neither knows the version the result is versionless
 * (`pkg:maven/org.apache.zeppelin/zeppelin-interpreter`), never `@UNKNOWN`, which no registry has.
 */
export function normalizePurl(purl: string | undefined, component?: PurlComponent): string | undefined {
    if (!purl?.startsWith('pkg:')) return undefined

    const body = purl.slice('pkg:'.length).split('?')[0].split('#')[0]
    const slash = body.indexOf('/')
    if (slash <= 0) return undefined
    const type = body.slice(0, slash).toLowerCase()
    const rest = body.slice(slash + 1)

    // The version follows the LAST '@', except that an npm scope may begin the name with one
    // (`@types/node`, unencoded, is legal): a '@' at position 0 is never the separator.
    const at = rest.lastIndexOf('@')
    const pathPart = at > 0 ? rest.slice(0, at) : rest
    const rawVersion = at > 0 ? rest.slice(at + 1) : ''

    let segments = pathPart.split('/').filter(it => it.length > 0).map(decode)
    if (segments.length === 0) return undefined
    segments = foldCase(type, segments, component)

    let version = decode(rawVersion).trim()
    if (!version) version = component?.version?.trim() ?? ''
    if (version.toUpperCase() === 'UNKNOWN') version = ''

    const key = `pkg:${type}/${segments.map(encodeURIComponent).join('/')}`
    return version ? `${key}@${encodeURIComponent(version)}` : key
}

/** Percent-decodes, leaving a malformed escape (`%zz`) as written rather than failing the purl. */
function decode(segment: string): string {
    try {
        return decodeURIComponent(segment)
    } catch {
        return segment
    }
}

/** Per-ecosystem case rules; see the file header. `segments` are decoded namespace + name. */
function foldCase(type: string, segments: string[], component?: PurlComponent): string[] {
    switch (type) {
        case 'npm':
        case 'composer':
        case 'nuget':
            return segments.map(it => it.toLowerCase())
        case 'pypi': {
            const name = segments[segments.length - 1]
            return [...segments.slice(0, -1), name.replace(/[-_.]+/g, '-').toLowerCase()]
        }
        case 'golang':
            return golangCase(segments, component)
        default:
            return segments
    }
}

/**
 * Golang module paths are case-sensitive, but Trivy lowercases them in the purl. Its component
 * `name` keeps the full path in the original case (`github.com/Masterminds/semver/v3`, no `group`),
 * so when the name spells the same path ignoring case, the name's spelling wins — which makes
 * Trivy's purl equal to Syft's. A name that is a different path is ignored.
 */
function golangCase(segments: string[], component?: PurlComponent): string[] {
    if (!component?.name) return segments
    const spelled = component.group ? `${component.group}/${component.name}` : component.name
    const path = segments.join('/')
    return spelled !== path && spelled.toLowerCase() === path.toLowerCase()
        ? spelled.split('/').filter(it => it.length > 0)
        : segments
}
