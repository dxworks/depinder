import {BadRequestError} from '../../../shared/errors.js'
import {DEFAULT_DEADLINE_MS, DEFAULT_MAX_AGE_S, MAX_DEADLINE_MS, MAX_PURLS, type ResolveRequest} from './types.js'

/** Validates the JSON body. Throws `BadRequestError`, which the route turns into a 400. */
export function parseResolveRequest(body: unknown): ResolveRequest {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new BadRequestError('body must be a JSON object')
    }
    // The field this replaced. Ignoring it would answer an old client with a stream it cannot read
    // and a deadline it did not ask for; refusing it, by name, makes it fail loudly instead.
    if ('wait_ms' in body) {
        throw new BadRequestError(
            `"wait_ms" is no longer accepted: send "deadline_ms" (milliseconds, default ${DEFAULT_DEADLINE_MS}, at most ${MAX_DEADLINE_MS})`,
        )
    }
    const {purls, deadline_ms: deadlineMs, max_age: maxAge} = body as {
        purls?: unknown
        deadline_ms?: unknown
        max_age?: unknown
    }

    if (!Array.isArray(purls)) throw new BadRequestError('"purls" must be an array of strings')
    if (purls.length > MAX_PURLS) {
        throw new BadRequestError(`"purls" holds ${purls.length} entries, the maximum is ${MAX_PURLS}`)
    }
    if (purls.some(p => typeof p !== 'string')) throw new BadRequestError('"purls" must contain strings only')

    let deadline = DEFAULT_DEADLINE_MS
    if (deadlineMs !== undefined && deadlineMs !== null) {
        if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs < 0) {
            throw new BadRequestError('"deadline_ms" must be a number of milliseconds >= 0')
        }
        if (deadlineMs > MAX_DEADLINE_MS) throw new BadRequestError(`"deadline_ms" must be <= ${MAX_DEADLINE_MS}`)
        deadline = deadlineMs
    }

    let maxAgeS = DEFAULT_MAX_AGE_S
    if (maxAge !== undefined && maxAge !== null) {
        if (typeof maxAge !== 'number' || !Number.isFinite(maxAge) || maxAge < 0) {
            throw new BadRequestError('"max_age" must be a number of seconds >= 0')
        }
        maxAgeS = maxAge
    }

    return {purls: purls as string[], deadlineMs: deadline, maxAgeS}
}
