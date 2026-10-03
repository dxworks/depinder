import {cargoRegistry} from './cargo.js'
import {composerRegistry} from './composer.js'
import {gemRegistry} from './gem.js'
import {golangRegistry} from './golang.js'
import {mavenRegistry} from './maven/index.js'
import {npmRegistry} from './npm.js'
import {nugetRegistry} from './nuget.js'
import {pypiRegistry} from './pypi/index.js'
import type {Registry} from './types.js'

/**
 * Every implemented ecosystem, keyed by purl type. All eight of `SUPPORTED_TYPES` are here.
 *
 * A supported purl type with no entry would still not be an error at boot: the API accepts those
 * purls, and the demand-fill worker marks each one `error` with "no registry implemented for
 * type X". That is what let the eight files land one at a time, and it is still what a ninth
 * ecosystem would do between its purl type and its registry file. See
 * `docs/adding-a-registry.md`.
 */
export const registries: Record<string, Registry> = {
    npm: npmRegistry,
    pypi: pypiRegistry,
    nuget: nugetRegistry,
    composer: composerRegistry,
    gem: gemRegistry,
    golang: golangRegistry,
    maven: mavenRegistry,
    cargo: cargoRegistry,
}

export function registryFor(type: string): Registry | undefined {
    return registries[type]
}

export * from './types.js'
