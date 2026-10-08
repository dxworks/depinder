// The public API of @depinder/core: everything the CLI and the server share. Nothing else is
// meant to be imported from outside this package.

export {createLogger, errorMessage, nullLogger, type Logger, type LogLevel} from './log.js'
export {
    canonicalPurl,
    fromRegistryName,
    isCaseSensitiveType,
    isSupportedType,
    normalisePypiName,
    parsePurl,
    registryName,
    splitPurl,
    SUPPORTED_TYPES,
    tryParsePurl,
    versionPurl,
    type ParsedPurl,
    type PurlParts,
} from './purl.js'
export {
    createHttpClient,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_USER_AGENT,
    HttpError,
    type HttpClient,
    type HttpClientOptions,
    type HttpResponse,
    type RequestEvent,
    type RequestGate,
    type RequestOptions,
} from './http/client.js'
export {retryAfterMs} from './http/retry-after.js'
export {
    createLimiter,
    createLimiterPool,
    limitFor,
    type EcosystemLimits,
    type LimiterPool,
    type LimitSpec,
    type RequestLimiter,
    type WaiterPicker,
} from './http/limiter.js'
export {mapWithConcurrency} from './concurrency.js'
export {MAVEN_PER_VERSION_LICENSES} from './facts.js'
export {canFetch, fetchPackage} from './fetch-package.js'
export {isPrerelease} from './registries/latest.js'
export {mavenMetadataUrl} from './registries/maven/index.js'
export {stringOrUndefined, toDate} from './registries/normalise.js'
export type {FetchContext, FetchedPackage, FetchedVersion, ResolvedPackage} from './registries/types.js'
export {
    distinctVersions,
    toPackageRecord,
    VERSION_FLAG_PRERELEASE,
    VERSION_FLAG_YANKED,
    versionPointer,
    type CompactVersion,
    type DistinctVersion,
    type PackageRecord,
    type VersionPointer,
} from './wire/package-record.js'
export {
    RESOLVE_DEFAULT_DEADLINE_MS,
    RESOLVE_DEFAULT_MAX_AGE_S,
    RESOLVE_MAX_DEADLINE_MS,
    RESOLVE_MAX_PURLS,
    type FeedFreshness,
    type ResolveItem,
    type ResolveLine,
    type ResolveRequestBody,
    type ResolveStatus,
    type ResolveTrailer,
} from './wire/resolve.js'
export {
    VULN_DEFAULT_MAX_PURLS,
    type VulnDatabaseBuild,
    type VulnRequestBody,
    type VulnResponse,
    type VulnUnsupportedReason,
} from './wire/vulnerabilities.js'
export {
    buildVulnerabilityIndex,
    type PackageKeyer,
    type PackageKeys,
    type VulnerabilityIndex,
} from './vuln/merge.js'
export type {GrypeReport} from './vuln/grype.js'
export type {TrivyReport} from './vuln/trivy.js'
export {PINNED_SCANNER_VERSIONS} from './vuln/scanner-versions.js'
export type {ScannedPackage, Vulnerability} from './vuln/vulnerability.js'
