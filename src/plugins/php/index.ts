import {AbstractRegistrar, LibrariesIORegistrar, LibraryInfo, Registrar} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import {getPackageDetails, IPackagistPackageDetails} from './php-interfaces'

export class PackagistRegistrar extends AbstractRegistrar {
    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const response: IPackagistPackageDetails = await getPackageDetails(libraryName)
        const latestVersion = Object.values(response.versions)
            .filter((it: any) => !it.version.includes('dev'))
            .sort(
            (a: any, b: any) => {
                return Date.parse(b.time) - Date.parse(a.time)
            }
        )[0]?.version
        return {
            name: response.name,
            versions: Object.values(response.versions).map((it: any) => {
                return {
                    version: it.version,
                    timestamp: Date.parse(it.time),
                    licenses: it.license,
                    latest: it.version === latestVersion,
                }
            }),
            description: response.description,
            issuesUrl: [],
            licenses: [...new Set(Object.values(response.versions).flatMap((it: any) => it.license).filter((it: any) => it != null))],
            reposUrl: [],
            // `Component Link`. Packagist is the one registry where Black Duck holds the source
            // repository rather than the declared homepage: on 70 sampled components `source.url`
            // agreed 40% of the time and composer's own `homepage` only 4%. The `.git` suffix is
            // stripped by `canonicalProjectUrl` at export, not here.
            homepageUrl: (Object.values(response.versions)
                .find((it: any) => it.version === latestVersion) as any)?.source?.url
                || (Object.values(response.versions).map((it: any) => it.source?.url).find((it: any) => it) ?? ''),
            keywords: [],
        }
    }
}

export const phpRegistrar: Registrar = new PackagistRegistrar(new LibrariesIORegistrar('packagist'))

export const phpChecker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'COMPOSER',
    getPURL: (lib, ver) => `pkg:composer/${lib.replace('@', '%40')}@${ver}`,
}
