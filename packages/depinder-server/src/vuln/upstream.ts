import {errorMessage} from '../shared/log.js'

/**
 * "Is there a newer build?", asked of the publishers directly, with one small HTTP read each.
 *
 * The tools only download. Trivy's own rule is to fetch once its `NextUpdate` (build + 24 h) has
 * passed, against a publish every ~6 h, and `grype db check` writes into the folder it checks. A
 * plain read of the publisher's metadata writes nothing and names the build exactly:
 *
 *   Trivy  the OCI manifest of `trivy-db:2`: the database layer's digest, and the manifest's
 *          `org.opencontainers.image.created` annotation
 *   Grype  `latest.json`: `checksum` and `built`
 *
 * Identity is the digest or checksum, never a time. Trivy's `created` is when the image was
 * pushed, a few minutes after the `UpdatedAt` the database itself carries (19:07:13Z against
 * 19:00:16Z on 2026-10-01), and it differs by seconds between mirror.gcr.io and ghcr.io for the
 * very same layer; so it is shown on `/health` and compared with nothing. Grype's `built` is the
 * same string `grype db status` reports, so it may also decide "nothing newer" without a download
 * (`exact`).
 */

export interface UpstreamBuild {
    /** The Trivy database layer's digest, or Grype's archive checksum. */
    id: string
    /** The publisher's time for the build, for `/health`. Null when it does not say. */
    built_at: string | null
    /** `built_at` is exactly what the downloaded database will report as its build time. */
    exact: boolean
}

/** The check could not tell: network, timeout, HTTP status, or a body that is not what it should be. */
export class UpstreamError extends Error {}

interface CheckOptions {
    fetch?: typeof fetch
    /** The whole check, token included. */
    timeoutMs?: number
    /** Stops the check early: the server is shutting down. */
    signal?: AbortSignal
}

const CHECK_TIMEOUT_MS = 30_000

/** The layer Trivy downloads. Any other layer is not the database. */
const TRIVY_DB_LAYER = 'application/vnd.aquasec.trivy.db.layer.v1.tar+gzip'
const MANIFEST_ACCEPT = [
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

interface OciReference {
    /** The host the API is spoken to: `mirror.gcr.io`, `ghcr.io`, `registry-1.docker.io`. */
    registry: string
    /** `aquasec/trivy-db` */
    repository: string
    /** A tag (`2`) or a digest (`sha256:...`). */
    reference: string
}

/**
 * `mirror.gcr.io/aquasec/trivy-db:2` → its parts, the way Docker reads a reference: the first
 * segment is a registry only if it has a dot or a port or is `localhost`, else it is Docker Hub.
 * With no tag the tag is `2`, the schema Trivy 0.74 asks for when it is given none.
 */
export function parseRepository(ref: string): OciReference {
    const trimmed = ref.trim()
    if (!trimmed || /\s|^[/:@]|\/\/|[/:@]$/.test(trimmed)) throw new Error(`not an OCI reference: ${ref}`)

    let name = trimmed
    let reference = '2'
    const at = name.indexOf('@')
    if (at >= 0) {
        reference = name.slice(at + 1)
        name = name.slice(0, at)
    } else {
        const colon = name.lastIndexOf(':')
        if (colon > name.lastIndexOf('/')) {
            reference = name.slice(colon + 1)
            name = name.slice(0, colon)
        }
    }

    const slash = name.indexOf('/')
    const first = slash >= 0 ? name.slice(0, slash) : ''
    let registry: string
    let repository: string
    if (first && (first.includes('.') || first.includes(':') || first === 'localhost')) {
        registry = first
        repository = name.slice(slash + 1)
    } else {
        registry = 'registry-1.docker.io'
        repository = slash >= 0 ? name : `library/${name}`
    }
    if (registry === 'docker.io') registry = 'registry-1.docker.io'
    if (!repository || !reference || !/^[a-z0-9._/-]+$/.test(repository)) throw new Error(`not an OCI reference: ${ref}`)
    return {registry, repository, reference}
}

/**
 * The reference as Trivy will be given it: the same string, with `:2` added when it had no tag, so
 * that the check and `--db-repository` can never mean two different things.
 */
export function normalizeRepository(ref: string): string {
    const trimmed = ref.trim()
    const parsed = parseRepository(trimmed)
    const hasReference = trimmed.includes('@') || trimmed.lastIndexOf(':') > trimmed.lastIndexOf('/')
    return hasReference ? trimmed : `${trimmed}:${parsed.reference}`
}

/**
 * The Trivy build at `repository`, by the generic anonymous OCI flow: GET the manifest; on a 401
 * with a `Bearer` challenge, fetch an anonymous token from the realm it names and ask once more.
 * mirror.gcr.io answers the first GET; ghcr.io needs the token.
 */
export async function checkTrivy(repository: string, options: CheckOptions = {}): Promise<UpstreamBuild> {
    const {registry, repository: name, reference} = parseRepository(repository)
    const url = `https://${registry}/v2/${name}/manifests/${reference}`
    return withDeadline(options, async (signal, fetchFn) => {
        let response = await fetchFn(url, {headers: {accept: MANIFEST_ACCEPT}, signal})
        if (response.status === 401) {
            const token = await anonymousToken(response.headers.get('www-authenticate'), name, signal, fetchFn)
            response = await fetchFn(url, {headers: {accept: MANIFEST_ACCEPT, authorization: `Bearer ${token}`}, signal})
        }
        if (!response.ok) throw new UpstreamError(`HTTP ${response.status} from ${url}`)

        const manifest = await json(response, url) as {
            layers?: {mediaType?: unknown, digest?: unknown}[]
            annotations?: Record<string, unknown>
        }
        const layer = manifest.layers?.find(it => it.mediaType === TRIVY_DB_LAYER)
        if (!layer || typeof layer.digest !== 'string') throw new UpstreamError(`${url} has no trivy-db layer`)
        const created = manifest.annotations?.['org.opencontainers.image.created']
        return {id: layer.digest, built_at: typeof created === 'string' ? created : null, exact: false}
    })
}

/** The Grype build `latest.json` names. */
export async function checkGrype(url: string, options: CheckOptions = {}): Promise<UpstreamBuild> {
    return withDeadline(options, async (signal, fetchFn) => {
        const response = await fetchFn(url, {headers: {accept: 'application/json'}, signal})
        if (!response.ok) throw new UpstreamError(`HTTP ${response.status} from ${url}`)
        const latest = await json(response, url) as {built?: unknown, checksum?: unknown}
        if (typeof latest.checksum !== 'string' || !latest.checksum || typeof latest.built !== 'string') {
            throw new UpstreamError(`${url} has no checksum or built`)
        }
        return {id: latest.checksum, built_at: latest.built, exact: true}
    })
}

/** `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"` → a token. */
async function anonymousToken(challenge: string | null, repository: string, signal: AbortSignal, fetchFn: typeof fetch): Promise<string> {
    if (!challenge || !/^bearer\s/i.test(challenge)) {
        throw new UpstreamError(`registry wants credentials (${challenge ?? 'no challenge'}); only anonymous pulls are supported`)
    }
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1]!.toLowerCase(), m[2]!]))
    if (!params.realm || !URL.canParse(params.realm)) throw new UpstreamError(`bearer challenge without a realm: ${challenge}`)
    const tokenUrl = new URL(params.realm)
    if (params.service) tokenUrl.searchParams.set('service', params.service)
    tokenUrl.searchParams.set('scope', params.scope ?? `repository:${repository}:pull`)

    const response = await fetchFn(tokenUrl, {signal})
    if (!response.ok) throw new UpstreamError(`HTTP ${response.status} from ${tokenUrl.origin}${tokenUrl.pathname}`)
    const body = await json(response, tokenUrl.href) as {token?: unknown, access_token?: unknown}
    const token = typeof body.token === 'string' ? body.token : body.access_token
    if (typeof token !== 'string' || !token) throw new UpstreamError(`no token from ${tokenUrl.origin}${tokenUrl.pathname}`)
    return token
}

async function json(response: Response, url: string): Promise<unknown> {
    try {
        return await response.json()
    } catch {
        throw new UpstreamError(`${url} did not answer JSON`)
    }
}

/** Runs `check` under one deadline and turns whatever goes wrong into an `UpstreamError`. */
async function withDeadline<T>(options: CheckOptions, check: (signal: AbortSignal, fetchFn: typeof fetch) => Promise<T>): Promise<T> {
    const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
    try {
        return await check(signal, options.fetch ?? fetch)
    } catch (e) {
        if (e instanceof UpstreamError) throw e
        if (deadline.aborted) throw new UpstreamError(`timed out after ${timeoutMs} ms`)
        if (options.signal?.aborted) throw new UpstreamError('aborted')
        // Node's fetch says only `fetch failed`; the DNS or TLS error is its cause.
        const cause = e instanceof Error && e.cause ? `: ${errorMessage(e.cause)}` : ''
        throw new UpstreamError(`${errorMessage(e)}${cause}`)
    }
}
