import {PackageURL} from 'packageurl-js'
import {BadRequestError} from '../shared/errors.js'
import {isSupportedType, tryParsePurl} from '@depinder/core'

/**
 * The body of `POST /vulnerabilities`, validated and sorted into what can be scanned and what
 * cannot.
 *
 * What goes into the dummy SBOM is the purl as the caller wrote it, decoded — NOT `parsePurl`'s
 * canonical form. That form is a database key: it lowercases npm, nuget and composer names and
 * PEP-503s pypi ones, and a scanner given `pkg:golang/github.com/burntsushi/toml` instead of
 * `BurntSushi` is looking for a different module. The scanners must see exactly what Phase 0 gave
 * them, which is the raw decoded parts.
 */

type UnsupportedReason = 'invalid' | 'no_version' | 'unsupported_type'

/** One distinct purl that goes into the scan. */
export interface Scannable {
    /** Exactly as sent: the key of the answer. */
    purl: string
    /** Without `?qualifiers` and `#subpath`: the component's `purl` in the SBOM. */
    bare: string
    /** Lowercased, and one of `SUPPORTED_TYPES`. */
    type: string
    /** Decoded, as written: `@nestjs`, `org.yaml`, `github.com/BurntSushi`. */
    namespace: string | null
    /** Decoded, as written. */
    name: string
    /** Decoded, as written. */
    version: string
}

interface VulnRequest {
    scan: Scannable[]
    unsupported: {purl: string, reason: UnsupportedReason}[]
}

/** More distinct purls than `VULN_MAX_PURLS`. A 413, with the limit, so the caller can split. */
export class TooManyPurlsError extends Error {
    constructor(readonly max: number) {
        super(`at most ${max} distinct purls per request`)
    }
}

/** Validates the JSON body. Throws `BadRequestError` (400) or `TooManyPurlsError` (413). */
export function parseVulnRequest(body: unknown, maxPurls: number): VulnRequest {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestError('body must be a JSON object')
    }
    const purls = (body as {purls?: unknown}).purls
    if (!Array.isArray(purls)) throw new BadRequestError('"purls" must be an array of strings')
    if (!purls.every((p): p is string => typeof p === 'string')) {
        throw new BadRequestError('"purls" must be an array of strings')
    }

    // Exact strings, first-seen order. Two spellings of one package stay two keys: the answer is
    // keyed by what was sent, and each spelling gets its own.
    const distinct = [...new Set(purls)]
    if (distinct.length > maxPurls) throw new TooManyPurlsError(maxPurls)

    const request: VulnRequest = {scan: [], unsupported: []}
    for (const purl of distinct) {
        const reason = classify(purl)
        if (typeof reason === 'string') request.unsupported.push({purl, reason})
        else request.scan.push(reason)
    }
    return request
}

function classify(purl: string): Scannable | UnsupportedReason {
    // Also what refuses a maven purl with no group and an empty name.
    const parsed = tryParsePurl(purl)
    if (!parsed.ok) return 'invalid'
    if (!isSupportedType(parsed.purl.type)) return 'unsupported_type'
    if (!parsed.purl.version) return 'no_version'

    // The same split `parsePurl` makes, without its canonicalisation. It has just succeeded on
    // this string, so it cannot throw here.
    const raw = purl.trim()
    const [, namespace, name, version] = PackageURL.parseString(raw)
    return {
        purl,
        bare: raw.split('?')[0]!.split('#')[0]!,
        type: parsed.purl.type,
        namespace: namespace || null,
        name: name!,
        version: version!,
    }
}
