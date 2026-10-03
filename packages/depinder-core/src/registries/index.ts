import {cargoFetcher} from './cargo.js'
import {composerFetcher} from './composer.js'
import {gemFetcher} from './gem.js'
import {golangFetcher} from './golang.js'
import {mavenFetcher} from './maven/index.js'
import {npmFetcher} from './npm.js'
import {nugetFetcher} from './nuget.js'
import {pypiFetcher} from './pypi.js'
import type {PackageFetcher} from './types.js'

/** Every implemented ecosystem's fetcher, keyed by purl type. All eight of `SUPPORTED_TYPES` are here. */
export const fetchers: Readonly<Record<string, PackageFetcher>> = {
    npm: npmFetcher,
    pypi: pypiFetcher,
    nuget: nugetFetcher,
    composer: composerFetcher,
    gem: gemFetcher,
    golang: golangFetcher,
    maven: mavenFetcher,
    cargo: cargoFetcher,
}

export function fetcherFor(type: string): PackageFetcher | undefined {
    return fetchers[type]
}
