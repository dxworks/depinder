import {LibraryInfo, Registrar} from '../../extension-points/registrar'
import {json} from 'npm-registry-fetch'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'

/**
 * `Component Link` for an npm package: the project it belongs to, as the package itself declares it.
 *
 * The packument's top-level `homepage` is the newest version's, and it is what Black Duck holds on
 * most rows; but a version can drop the field while an older one still carries it, and a package
 * with no `homepage` at all still names its `repository`. Black Duck fills the cell from both (on
 * 40 sampled rows where we wrote nothing it held the resolved version's `homepage` 17 times, the
 * `repository` 12 times, another version's `homepage` 9 times), so the search runs newest version
 * first, `homepage` before `repository`, and stops at the first that declares anything.
 *
 * Where the two exports still differ the cause is on the other side: Black Duck's link is the one
 * declared by the OLDEST published version, frozen when the component entered its Knowledge Base
 * (`ternjs/Acorn` for an acorn from 2024, `facebook/jest` for a jest from 2026). That is not
 * reproduced on purpose -- a link that resolves only through a rename redirect is not the project.
 */
export function npmProjectUrl(packument: any): string {
    if (typeof packument?.homepage === 'string' && packument.homepage.trim()) return packument.homepage
    const time = packument?.time ?? {}
    const versions: any[] = Object.values(packument?.versions ?? {})
        .sort((a: any, b: any) => (Date.parse(time[b.version]) || 0) - (Date.parse(time[a.version]) || 0))
    for (const version of versions) {
        if (typeof version.homepage === 'string' && version.homepage.trim()) return version.homepage
        const repository = typeof version.repository === 'string' ? version.repository : version.repository?.url
        if (typeof repository === 'string' && repository.trim()) return repository
    }
    return ''
}

export async function retrieveFromNpm(libraryName: string): Promise<LibraryInfo> {
    const response: any = await json(libraryName)

    return {
        name: response.name,
        versions: Object.values(response.versions).map((it: any) => {
            return {
                version: it.version,
                timestamp: Date.parse(response.time[it.version]),
                licenses: it.license,
                latest: it.version == response['dist-tags']?.latest,
            }
        }),
        description: response.description,
        issuesUrl: [],
        // A package with no `license` must yield [], not [undefined]: the cache serialises that as
        // [null], which a warm run then wrote into the Licenses cell as the text `null`.
        licenses: response.license != null ? [response.license] : [],
        reposUrl: [],
        homepageUrl: npmProjectUrl(response),
        keywords: response.keywords,
    }
}

export const npmRegistrar: Registrar = {
    retrieve: retrieveFromNpm,
}

export const npmChecker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'NPM',
    getPURL: (lib, ver) => `pkg:npm/${lib.replace('@', '%40')}@${ver}`,
}
