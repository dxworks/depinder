import {PackageURL} from 'packageurl-js'

/**
 * purl parsing and canonicalisation.
 *
 * Everything in the database is keyed by `packageKey`: a purl with no version, no qualifiers and
 * no subpath, whose namespace and name have been canonicalised per ecosystem. Two purls that name
 * the same package must produce the same key, because that key is a primary key and the unit the
 * feeds, the queue and the API all speak in.
 *
 * The one deviation from `PackageURL.toString()` is that `@` is left un-encoded, so an npm scope
 * reads `pkg:npm/@babel/core` rather than `pkg:npm/%40babel/core`. Keys end up in logs, in SQL
 * and in the API response; `%40` there is noise. Both spellings parse to the same key.
 */

export const SUPPORTED_TYPES = [
    'npm',
    'maven',
    'pypi',
    'nuget',
    'composer',
    'gem',
    'golang',
    'cargo',
] as const

type SupportedType = (typeof SUPPORTED_TYPES)[number]

export interface ParsedPurl {
    type: string
    /** npm scope (with `@`), maven group, composer vendor, golang module prefix; null otherwise. */
    namespace: string | null
    name: string
    /** null when the input carried no version (a package-level purl). */
    version: string | null
    /** Canonical purl without version, qualifiers or subpath. The database primary key. */
    packageKey: string
}

class PurlError extends Error {}

export function isSupportedType(type: string): type is SupportedType {
    return (SUPPORTED_TYPES as readonly string[]).includes(type)
}

/** Parses and canonicalises. Throws `PurlError` on anything that is not a usable purl. */
export function parsePurl(input: string): ParsedPurl {
    const raw = input?.trim()
    if (!raw) throw new PurlError('empty purl')

    // `parseString` splits and percent-decodes the components; `fromString` would additionally
    // run packageurl-js's own per-type normalisation, which we do not want. We canonicalise
    // ourselves below (its pypi rule is not PEP 503, for one), and as of 2.0.1 its golang
    // validator throws a ReferenceError on versions like `v1` that are not valid semver.
    let parts: [string?, string?, string?, string?, unknown?, unknown?]
    try {
        parts = PackageURL.parseString(raw)
    } catch (e) {
        throw new PurlError(e instanceof Error ? e.message : String(e))
    }

    const [rawType, rawNamespace, rawName, rawVersion] = parts
    if (!rawType) throw new PurlError('purl has no type')
    if (!rawName) throw new PurlError('purl has no name')

    const type = rawType.toLowerCase()
    const {namespace, name} = canonicalise(type, rawNamespace || null, rawName)
    if (!name) throw new PurlError('purl has no name')
    if (type === 'maven' && !namespace) throw new PurlError('a maven purl needs its group id as the namespace')

    return {
        type,
        namespace,
        name,
        version: rawVersion?.trim() || null,
        packageKey: buildPackageKey(type, namespace, name),
    }
}

/** Non-throwing `parsePurl`, for request handling where a bad purl is data, not an exception. */
export function tryParsePurl(input: string): {ok: true; purl: ParsedPurl} | {ok: false; reason: string} {
    try {
        return {ok: true, purl: parsePurl(input)}
    } catch (e) {
        return {ok: false, reason: e instanceof Error ? e.message : String(e)}
    }
}

/**
 * Per-ecosystem canonicalisation. Deliberately conservative: only the rules the ecosystems
 * themselves define, because anything more would merge two packages that upstream keeps apart.
 *
 *  - npm: names are lowercase; the scope stays the namespace, with its `@`.
 *  - nuget: ids are case-insensitive, the registry serves them lowercased.
 *  - pypi: PEP 503 — lowercase and collapse runs of `-`, `_` and `.` to a single `-`.
 *  - composer: vendor and package are case-insensitive on Packagist.
 *  - maven, gem, golang, cargo: case-sensitive upstream, left exactly as given.
 */
function canonicalise(type: string, namespace: string | null, name: string): {namespace: string | null; name: string} {
    switch (type) {
        case 'npm':
            return {namespace: namespace ? namespace.toLowerCase() : null, name: name.toLowerCase()}
        case 'nuget':
            return {namespace: null, name: name.toLowerCase()}
        case 'pypi':
            return {namespace: null, name: normalisePypiName(name)}
        case 'composer':
            return {namespace: namespace ? namespace.toLowerCase() : null, name: name.toLowerCase()}
        default:
            return {namespace: namespace || null, name}
    }
}

/** PEP 503: `re.sub(r"[-_.]+", "-", name).lower()`. */
export function normalisePypiName(name: string): string {
    return name.replace(/[-_.]+/g, '-').toLowerCase()
}

function buildPackageKey(type: string, namespace: string | null, name: string): string {
    const path = namespace ? `${encodeSegments(namespace)}/${encodeSegment(name)}` : encodeSegment(name)
    return `pkg:${type}/${path}`
}

/** A namespace may hold several `/`-separated segments (golang module paths). */
function encodeSegments(namespace: string): string {
    return namespace.split('/').map(encodeSegment).join('/')
}

/**
 * Only the characters that would change how the purl parses are escaped. `@` is kept, see the
 * file header.
 */
function encodeSegment(segment: string): string {
    return segment.replace(/%/g, '%25').replace(/\?/g, '%3F').replace(/#/g, '%23')
}

function encodeVersion(version: string): string {
    return version
        .replace(/%/g, '%25')
        .replace(/\//g, '%2F')
        .replace(/\?/g, '%3F')
        .replace(/#/g, '%23')
}

/** `pkg:npm/lodash` + `4.17.21` -> `pkg:npm/lodash@4.17.21`. The `package_version` primary key. */
export function versionPurl(packageKey: string, version: string): string {
    return `${packageKey}@${encodeVersion(version)}`
}

/**
 * The name the registry's own API expects, which is not always the purl name:
 *
 *   maven     `com.google.guava:guava`   (group:artifact)
 *   npm       `@babel/core`
 *   composer  `symfony/console`
 *   golang    `github.com/gin-gonic/gin` (the full module path)
 *   others    the bare name
 */
export function registryName(parsed: Pick<ParsedPurl, 'type' | 'namespace' | 'name'>): string {
    const {type, namespace, name} = parsed
    if (!namespace) return name
    if (type === 'maven') return `${namespace}:${name}`
    return `${namespace}/${name}`
}

/**
 * The inverse of `registryName`: builds a purl from a registry-shaped name. Used by feeds that
 * report package names rather than purls.
 */
export function fromRegistryName(type: string, name: string, version?: string | null): ParsedPurl {
    const trimmed = name.trim()
    if (!trimmed) throw new PurlError(`empty ${type} package name`)

    let namespace: string | null = null
    let bare = trimmed

    if (type === 'maven') {
        const idx = trimmed.indexOf(':')
        if (idx <= 0 || idx === trimmed.length - 1) {
            throw new PurlError(`maven name must be "group:artifact" (got "${trimmed}")`)
        }
        namespace = trimmed.slice(0, idx)
        bare = trimmed.slice(idx + 1)
    } else if (type === 'npm' || type === 'composer' || type === 'golang') {
        const idx = trimmed.lastIndexOf('/')
        if (idx > 0) {
            namespace = trimmed.slice(0, idx)
            bare = trimmed.slice(idx + 1)
        }
    }

    const canon = canonicalise(type, namespace, bare)
    if (!canon.name) throw new PurlError(`empty ${type} package name`)
    return {
        type,
        namespace: canon.namespace,
        name: canon.name,
        version: version ?? null,
        packageKey: buildPackageKey(type, canon.namespace, canon.name),
    }
}
