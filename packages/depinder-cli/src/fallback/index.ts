// The CLI's fallback road and the adapter it ends in (the resolver's answers end there too), for
// the parity tests. Bundled code never imports this file.

export {fetchLibraryInfo, type FallbackDeps, type FallbackPackage, type FallbackResult} from './fetch-library-info'
export {createRegistryClients, type RegistryClients, type RegistryClientsOptions} from './registry-clients'
export {toLibraryInfo} from '../resolver/adapter'
export type {LibraryInfo} from '../extension-points/registrar'
