import {nullLogger, type FetchContext, type Logger} from '@depinder/core'
import {createRegistryClient} from '../../../src/resolver/registries/http.js'
import type {FeedSpec} from '../../../src/resolver/registries/types.js'

export {coreFixture, serverFixture as feedFixture} from '../../fixtures.helpers.js'

/** What the feed and poll tests share: the recorded answers, a context and the two feed shapes. */

/** A logger that keeps what was warned about in `warnings`. */
export function warningsLogger(warnings: {msg: string; fields?: Record<string, unknown>}[]): Logger {
    const logger: Logger = {...nullLogger, warn: (msg, fields) => warnings.push({msg, fields}), child: () => logger}
    return logger
}

export function feedContext(type: string, log: Logger = nullLogger): FetchContext {
    return {http: createRegistryClient({type}), log, options: {mavenPerVersionLicenses: false}}
}

/** The feed-mode half of a spec, or a failed test when it is a poll. */
export function feedMode(spec: FeedSpec): Extract<FeedSpec, {mode: 'feed'}> {
    if (spec.mode !== 'feed') throw new Error('expected a feed-mode registry')
    return spec
}

/** The poll-mode half of a spec, or a failed test when it is a feed. */
export function pollMode(spec: FeedSpec): Extract<FeedSpec, {mode: 'poll'}> {
    if (spec.mode !== 'poll') throw new Error('expected a poll-mode registry')
    return spec
}
