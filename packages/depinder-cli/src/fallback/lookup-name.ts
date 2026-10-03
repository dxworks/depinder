import {errorMessage, registryName, tryParsePurl} from '@depinder/core'
import {log} from '../utils/logging'

/**
 * The name the registry fallback asks for. Trivy lowercases golang module paths, so a dependency's
 * name (and its cache key) can be `github.com/masterminds/sprig/v3` while the module is
 * `github.com/Masterminds/sprig/v3`; proxy.golang.org and deps.dev only know the latter. The case
 * restored into the purl (see `normalizePurl`) is what the resolver is asked with, and the
 * fallback asks with the same spelling. Cache keys stay on the dependency's own name.
 */

/** Ecosystems whose registries tell names apart by case; the others fold them in the purl. */
const CASE_SENSITIVE_TYPES = new Set(['golang', 'maven', 'gem', 'cargo'])

/** The dependency's name as its purl spells it, when that is the same name in another case. */
export function fallbackLookupName(dep: {name: string, purl?: string}): string {
    if (!dep.purl) return dep.name
    const parsed = tryParsePurl(dep.purl)
    if (!parsed.ok) return dep.name
    return sameNameOtherCase(parsed.purl.type, dep.name, registryName(parsed.purl)) ?? dep.name
}

/**
 * `update` only has the cache key's name; the cached library's own name keeps the spelling it was
 * fetched (or resolved) with, so that one is re-fetched when it is the same name in another case.
 */
export function refetchLookupName(type: string, keyName: string, cachedName: string | undefined): string {
    return (cachedName && sameNameOtherCase(type, keyName, cachedName)) ?? keyName
}

function sameNameOtherCase(type: string, name: string, candidate: string): string | undefined {
    const differsOnlyInCase = candidate !== name && candidate.toLowerCase() === name.toLowerCase()
    return CASE_SENSITIVE_TYPES.has(type) && differsOnlyInCase ? candidate : undefined
}

/** One line saying which lookup failed and why; a bare `log.error(e)` printed only "error". */
export function logLookupFailure(name: string, ecosystem: string, e: unknown): void {
    log.error(`Registry lookup failed for ${ecosystem} package ${name}: ${withCause(e)}`)
}

/** Node's fetch says only "fetch failed"; the reason (a reset, a DNS error) is in its cause. */
function withCause(e: unknown): string {
    const cause = e instanceof Error ? (e as {cause?: unknown}).cause : undefined
    return cause ? `${errorMessage(e)} (${errorMessage(cause)})` : errorMessage(e)
}
