// The public API of @depinder/core: everything the CLI and the server share. Nothing else is
// meant to be imported from outside this package.

export {createLogger, errorMessage, nullLogger, type Logger, type LogLevel} from './log.js'
export {
    fromRegistryName,
    isSupportedType,
    normalisePypiName,
    parsePurl,
    registryName,
    SUPPORTED_TYPES,
    tryParsePurl,
    versionPurl,
    type ParsedPurl,
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
