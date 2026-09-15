import axios from 'axios'
import {Plugin} from '../../extension-points/plugin'
import {AbstractRegistrar, LibrariesIORegistrar, LibraryInfo, Registrar} from '../../extension-points/registrar'
import {
    DependencyFileContext,
    DepinderDependency,
    DepinderProject,
    Extractor,
    Parser,
} from '../../extension-points/extract'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import moment from 'moment'

import {runNuGetInspectorProgrammatically} from '@dxworks/nuget-inspector'
import fs from 'fs'
import path from 'path'
import {getPackageSemver} from '../../utils/utils'
import {log} from '../../utils/logging'

const extractor: Extractor = {
    files: ['*.csproj', '*.fsproj', '*.vbproj'],
    createContexts: (files: string[]) =>
        files.map(it => ({
            root: path.dirname(it),
            manifestFile: it,
        } as DependencyFileContext)),
}

function transformNugetInspectorResult(result: any): DepinderProject {

    const project = result.Containers[0]
    const projectId = `${project.Name}@${project.Version}`

    if (!project) {
        throw new Error('Parsing NuGet Inspector result failed.')
    }

    const depMap: Map<string, DepinderDependency> = new Map<string, DepinderDependency>()
    project.Packages.forEach((pack: any) => {
        const packageId = `${pack.PackageId.Name}@${pack.PackageId.Version}`
        if (!depMap.has(packageId)) {
            depMap.set(packageId, {
                name: pack.PackageId.Name,
                version: pack.PackageId.Version,
                id: packageId,
                semver: getPackageSemver(pack.PackageId.Version),
                requestedBy: [],
                type: 'library',
            })
        }
        pack.Dependencies.forEach((dep: any) => {
            const depId = `${dep.Name}@${dep.Version}`
            if (!depMap.has(depId)) {
                depMap.set(depId, {
                    name: dep.Name,
                    version: dep.Version,
                    id: depId,
                    semver: getPackageSemver(dep.Version),
                    requestedBy: [packageId],
                    type: 'library',
                })
            } else {
                const cachedDep = depMap.get(depId)
                if (cachedDep) {
                    cachedDep.requestedBy.push(packageId)
                }
            }
        })
    })
    project.Dependencies.forEach((dep: any) => {
        const depId = `${dep.Name}@${dep.Version}`
        if(depMap.has(depId)) {
            const cachedDep = depMap.get(depId)
            if (cachedDep) {
                cachedDep.requestedBy.push(projectId)
            }
        }
    })

    return {
        name: project.Name,
        version: project.Version,
        path: project.SourcePath,
        dependencies: Object.fromEntries(depMap),
    }
}

export async function runNugetInspector(context: DependencyFileContext): Promise<DepinderProject> {
    const tempFile = path.resolve(`${context.manifestFile}.json`)
    if (!fs.existsSync(tempFile)) {
        try {
            await runNuGetInspectorProgrammatically(context.root, tempFile, process.cwd())
        } catch (e) {
            log.error(e)
            throw new Error(`NuGet Inspector failed for project ${context.root}`)
        }
    }

    const result = JSON.parse(fs.readFileSync(tempFile).toString())

    return transformNugetInspectorResult(result)
}

const parser: Parser = {
    parseDependencyTree: runNugetInspector,
}


const checker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'NUGET',
    getPURL: (lib, ver) => `pkg:nuget/${lib.replace('@', '%40')}@${ver}`,
}

/**
 * Registration hive `semver2`, not `semver1`. The two hives serve the same index shape, but
 * `semver1` filters out every version that is SemVer 2.0.0 — a build-metadata suffix, a dotted
 * prerelease label — or that depends on one, and that filter is not a fringe case: it hid 68 of
 * 109 `Microsoft.Bcl.AsyncInterfaces` versions, and on a twelve-repository run left 288 components
 * with no release date because the very version the project used was not in the list. `semver2`
 * is a superset of `semver1`, so nothing is gained by falling back from one to the other.
 */
export const NUGET_REGISTRATION_URL = 'https://api.nuget.org/v3/registration5-gz-semver2'

export class NugetRegistrar extends AbstractRegistrar {
    protected baseURL = NUGET_REGISTRATION_URL

    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const response = await axios.get(`${this.baseURL}/${libraryName.toLowerCase()}/index.json`)
        return this.parseData(await this.inlinePages(response.data))
    }

    /**
     * A registration index inlines its pages only while the package has few versions (128 on
     * nuget.org). Past that, each page carries just `@id` and `count`, and the versions live one
     * request further. Every package with a long release history — `AutoMapper`,
     * `Microsoft.EntityFrameworkCore`, `FluentValidation` — is of that kind, so without this the
     * registrar answered for the small packages and failed on exactly the ones a project depends on.
     */
    async inlinePages(index: any): Promise<any> {
        const pages: any[] = index?.items || []
        const items = await Promise.all(pages.map(async page =>
            page.items || !page['@id'] ? page : (await axios.get(page['@id'])).data))
        return {...index, items}
    }

    parseData(responseData: any): LibraryInfo {
        const versions: any[] = responseData?.items?.flatMap((it: any) => it.items) || []

        versions.sort((a, b) => moment(b.catalogEntry.published).valueOf() - moment(a.catalogEntry.published).valueOf())

        const latestVersion = versions[0].catalogEntry.version
        // if(versions) {
        return {
            name: versions[0].catalogEntry.id,
            versions: versions?.map(it => {
                return {
                    version: it.catalogEntry.version,
                    licenses: `${it.catalogEntry?.licenseExpression || ''} ${it.catalogEntry?.licenseUrl}`.trim(),
                    timestamp: moment(it.catalogEntry.published).valueOf(),
                    latest: it.catalogEntry.version === latestVersion,
                }
            }),
            licenses: [...new Set(versions.map(it => `${it.catalogEntry?.licenseExpression || ''} ${it.catalogEntry?.licenseUrl}`.trim()))],
            // `Component Link`: the newest version that declares one, since the column is a
            // property of the component and older entries often leave `projectUrl` unset.
            // Agreed with Black Duck on 32% of 38 sampled components that have a link.
            homepageUrl: versions.map(it => it.catalogEntry?.projectUrl).find(it => it) || '',
            requiresLicenseAcceptance: versions.some(it => it.catalogEntry.requireLicenseAcceptance),
        }
    }
}

export const registrar: Registrar = new NugetRegistrar(new LibrariesIORegistrar('nuget'))

export const dotnet: Plugin = {
    name: 'dotnet',
    aliases: ['.net', 'c#', 'csharp', 'nuget'],
    extractor,
    parser,
    registrar,
    checker,
}
