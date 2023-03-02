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
import {log} from '@dxworks/cli-common'

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
            const output = await runNuGetInspectorProgrammatically(context.root, tempFile, process.cwd())
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

export class NugetRegistrar extends AbstractRegistrar {
    protected baseURL = 'https://api.nuget.org/v3/registration5-gz-semver1'

    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const response = await axios.get(`${this.baseURL}/${libraryName.toLowerCase()}/index.json`)
        return this.parseData(response.data)
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
            requiresLicenseAcceptance: versions.some(it => it.catalogEntry.requireLicenseAcceptance),
        }
    }
}

class NugetRegistrarSemver2 extends NugetRegistrar {
    protected baseURL = 'https://api.nuget.org/v3/registration5-gz-semver2'
}

export const registrar: Registrar = new NugetRegistrar(new NugetRegistrarSemver2(new LibrariesIORegistrar('nuget')))

export const dotnet: Plugin = {
    name: 'dotnet',
    extractor,
    parser,
    registrar,
    checker,
}
