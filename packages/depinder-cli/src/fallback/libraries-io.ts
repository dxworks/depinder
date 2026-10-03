import {LibrariesIORegistrar, LibraryInfo, RegistryType} from '../extension-points/registrar'

/**
 * Libraries.io, the CLI's last resort (D8): only for the four ecosystems old depinder chained it
 * behind, and only with a key. npm, gem, cargo and Go never had it.
 */

/** Libraries.io's platform name per purl type, for the ecosystems that may use it. */
const LIBRARIES_IO_PLATFORMS: Readonly<Record<string, RegistryType>> = {
    maven: 'maven',
    pypi: 'pypi',
    nuget: 'nuget',
    composer: 'packagist',
}

export interface LibrariesIoFallback {
    /** Whether a package of this purl type that the registry could not answer goes to Libraries.io. */
    covers(type: string): boolean
    retrieve(type: string, name: string): Promise<LibraryInfo>
}

/** The real Libraries.io client; `covers` is false for every type while no key is set. */
export function librariesIoFallback(): LibrariesIoFallback {
    const registrars = new Map<string, LibrariesIORegistrar>()
    const registrarFor = (type: string) => {
        let registrar = registrars.get(type)
        if (!registrar) {
            registrar = new LibrariesIORegistrar(LIBRARIES_IO_PLATFORMS[type])
            registrars.set(type, registrar)
        }
        return registrar
    }
    return {
        covers: type => type in LIBRARIES_IO_PLATFORMS && registrarFor(type).isConfigured(),
        retrieve: (type, name) => registrarFor(type).retrieve(name),
    }
}
