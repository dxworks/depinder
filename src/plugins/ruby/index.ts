import {
    DependencyFileContext,
    DepinderDependency,
    DepinderProject,
    Extractor,
    Parser,
} from '../../extension-points/extract'
// @ts-ignore
import * as gemfile from '@snyk/gemfile'
import path from 'path'
import semver from 'semver/preload'
import {Registrar} from '../../extension-points/registrar'
import fetch from 'node-fetch'
import {Plugin} from '../../extension-points/plugin'
import {VulnerabilityChecker} from '../../../core/vulnerability-checker'
import {LibraryInfo} from '../../../core/library'

const extractor: Extractor = {
    files: ['Gemfile', '*.gemspec', 'Gemfile.lock'],
    createContexts: files =>
        files.filter(it => it.endsWith('Gemfile.lock')).map(it => ({
            root: path.dirname(it),
            lockFile: path.basename(it),
        } as DependencyFileContext)),
}

const parser: Parser = {
    parseDependencyTree: parseLockFile,
}

function transformDeps(tree: any, root: string) {

    const result: { [id: string]: DepinderDependency } = {}

    const directDeps = new Set(Object.keys(tree.dependencies))

    Object.keys(tree.specs).forEach(specName => {
        const value = tree.specs[specName]
        const id = `${specName}@${value.version}`
        result[id] = {
            id,
            name: specName,
            version: value.version,
            semver: semver.coerce(value.version),
            type: value.type,
            requestedBy: [],
        } as DepinderDependency
    })

    Object.keys(tree.specs).forEach(specName => {
        const value = tree.specs[specName]
        const id = `${specName}@${value.version}`
        Object.keys(value).filter(it => !['version', 'remote', 'type'].includes(it)).forEach(spec => {
            const cachedValue = result[id] as DepinderDependency
            if (cachedValue && value[spec].version) {
                cachedValue.requestedBy =[...cachedValue.requestedBy, id]
            }
        })
    })

    // TODO: read Gemfile and add the requestedBy field for the direct dependencies
    directDeps.forEach(dep => {
        const key = Object.keys(result).find(it => it.startsWith(`${dep}@`))
        if(!key) return
        const cachedValue = result[key] as DepinderDependency
        if(cachedValue) {
            cachedValue.requestedBy = [...cachedValue.requestedBy, root]
        }
    })

    return result
}

function parseLockFile({root, lockFile}: DependencyFileContext): DepinderProject {
    const result = gemfile.parseSync(path.resolve(root, lockFile), true)

    return {
        name: path.basename(root),
        path: root,
        version: '',
        dependencies: transformDeps(result, `${path.basename(root)}@`),
    } as DepinderProject
}

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

const registrar: Registrar = {
    retrieve: retrieveFormRubyGems,
}

const checker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'RUBYGEMS',
    getPURL: (lib, ver) => `pkg:gem/${lib}@${ver}`,
}

export const ruby: Plugin = {
    name: 'ruby',
    aliases: ['gem'],
    extractor,
    parser,
    registrar,
    checker,
}

