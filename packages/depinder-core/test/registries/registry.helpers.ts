import {readFileSync} from 'node:fs'
import {createHttpClient, type RequestEvent} from '../../src/http/client.js'
import {createLimiter} from '../../src/http/limiter.js'
import {nullLogger, type Logger} from '../../src/log.js'
import type {FetchContext} from '../../src/registries/types.js'

/** What the registry tests share: the recorded registry answers and a context that sees every request. */

/** A recorded registry answer from `test/fixtures/`, as text. */
export function fixtureText(name: string): string {
    return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
}

/** A recorded JSON answer, `name` without its `.json`. */
export function fixtureJson<T = Record<string, unknown>>(name: string): T {
    return JSON.parse(fixtureText(`${name}.json`)) as T
}

/** A request as the tests look at it: the event core's client reports, plus the host it went to. */
export interface SeenRequest extends RequestEvent {
    source: string
}

/** A context whose client tells `seen` about every request, with an open limiter of its own. */
export function testContext(seen: SeenRequest[], log: Logger = nullLogger, mavenPerVersionLicenses = false): FetchContext {
    return {
        http: createHttpClient({
            limiter: createLimiter({concurrency: 8, minIntervalMs: 0}),
            onRequest: event => seen.push({...event, source: new URL(event.url).host}),
        }),
        log,
        options: {mavenPerVersionLicenses},
    }
}
