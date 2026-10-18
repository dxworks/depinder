import {cargoPoll} from './cargo-poll.js'
import {composerFeed} from './composer-feed.js'
import {gemFeed} from './gem-feed.js'
import {golangFeed} from './golang-feed.js'
import {mavenPoll} from './maven-poll.js'
import {npmFeed} from './npm-feed.js'
import {nugetFeed} from './nuget-feed.js'
import {pypiFeed} from './pypi-feed.js'
import type {FeedSpec, Registry} from './types.js'

/**
 * Every ecosystem's feed, keyed by purl type: all eight of `SUPPORTED_TYPES`. Fetching a package
 * is core's `fetchPackage`; this map is what keeps the fetched packages fresh. See
 * `docs/adding-a-registry.md`.
 */
const feeds: Record<string, FeedSpec> = {
    npm: npmFeed,
    pypi: pypiFeed,
    nuget: nugetFeed,
    composer: composerFeed,
    gem: gemFeed,
    golang: golangFeed,
    maven: mavenPoll,
    cargo: cargoPoll,
}

export const registries: Record<string, Registry> = Object.fromEntries(
    Object.entries(feeds).map(([type, feed]) => [type, {type, feed}]),
)

/** How long after a feed-triggered fetch of a `type` package its second look comes. 0 in poll mode. */
export function recheckAfterMs(type: string): number {
    const feed = registries[type]?.feed
    return feed?.mode === 'feed' ? feed.recheckAfterMs : 0
}

export * from './types.js'
