import {createHttpClient, createLimiterPool, type EcosystemLimits, type HttpClient, type RequestEvent} from '@depinder/core'

/**
 * The CLI's way to the registries: one core HTTP client per purl type, each behind that
 * ecosystem's limiter. The limits are the caller's (D18); this file has no numbers of its own.
 */

/** Hands out the HTTP client a package's registry requests go through. */
export interface RegistryClients {
    forType(type: string): HttpClient
}

export interface RegistryClientsOptions {
    /** Requests in flight at once and the gap between their starts, per purl type. */
    limits: EcosystemLimits
    userAgent?: string
    timeoutMs?: number
    /** Told about every request once it settles, retries included. */
    onRequest?: (event: RequestEvent) => void
}

export function createRegistryClients(options: RegistryClientsOptions): RegistryClients {
    const limiters = createLimiterPool(options.limits)
    const clients = new Map<string, HttpClient>()
    return {
        forType(type) {
            let client = clients.get(type)
            if (!client) {
                client = createHttpClient({
                    limiter: limiters.forType(type),
                    userAgent: options.userAgent,
                    timeoutMs: options.timeoutMs,
                    onRequest: options.onRequest,
                    // A 429 is waited out once, so a higher CLI limit cannot turn into missing data.
                    retryRateLimited: true,
                })
                clients.set(type, client)
            }
            return client
        },
    }
}
