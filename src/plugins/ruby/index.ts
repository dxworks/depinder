import {LibraryInfo, Registrar} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'

const registrarCache: Map<string, LibraryInfo> = new Map<string, LibraryInfo>()

export async function retrieveFormRubyGems(libraryName: string): Promise<LibraryInfo> {
    if(registrarCache.has(libraryName))
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return registrarCache.get(libraryName)!

    const gemResponse: any = await fetch(`https://rubygems.org/api/v1/gems/${libraryName}.json`)
    const gemData = await gemResponse.json()
    const versionsResponse: any = await fetch(`https://rubygems.org/api/v1/versions/${libraryName}.json`)
    const versionsData = await versionsResponse.json()

    const libInfo =  {
        name: gemData.name,
        versions: versionsData.map((it: any) => {
            return {
                version: it.number,
                timestamp: Date.parse(it.created_at),
                buildAt: Date.parse(it.built_at),
                licenses: it.licenses,
                latest: it.number == gemData.version,
                rubyVersion: it.ruby_version,
                rubygemsVersion: it.rubygems_version,
            }
        }),
        description: gemData.info,
        issuesUrl: [gemData.metadata.bug_tracker_uri],
        licenses: gemData.licenses,
        reposUrl: [gemData.metadata.source_code_uri],
        documentationUrl: gemData.metadata.documentation_uri,
        homepageUrl: gemData.homepage_uri,
        packageUrl: gemData.gem_uri,
        keywords: [],
        downloads: gemData.downloads,
    }
    registrarCache.set(libraryName, libInfo)

    return libInfo
}

export const rubyRegistrar: Registrar = {
    retrieve: retrieveFormRubyGems,
}

export const rubyChecker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'RUBYGEMS',
    getPURL: (lib, ver) => `pkg:gem/${lib}@${ver}`,
}
