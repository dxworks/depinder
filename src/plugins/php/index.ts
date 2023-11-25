import {
    DependencyFileContext,
    DepinderDependency,
    DepinderProject,
    Extractor,
    Parser,
} from '../../extension-points/extract'
import path from 'path'
import fs from 'fs'
import {AbstractRegistrar, LibrariesIORegistrar, Registrar} from '../../extension-points/registrar'
import {Plugin} from '../../extension-points/plugin'
import {Composer, ComposerLock} from '../../info/php/parser'
import {getPackageDetails, IPackagistPackageDetails} from './php-interfaces'
import {getPackageSemver} from '../../utils/utils'
import {VulnerabilityChecker} from '../../../core/vulnerability-checker'
import {LibraryInfo} from '../../../core/library'

const extractor: Extractor = {
    files: ['composer.json', 'composer.lock'],
    createContexts: files => {
        return files.filter(it => it.endsWith('composer.lock')).map(it => ({
            root: path.dirname(it),
            lockFile: path.basename(it),
            manifestFile: 'composer.json',
        } as DependencyFileContext))
    },
    filter: it => !it.includes('/vendor'),
}

export function parseComposerFile(file: string): Composer {
    return JSON.parse(fs.readFileSync(file).toString()) as Composer
}

export function parseComposerLockFile(file: string): ComposerLock {
    return JSON.parse(fs.readFileSync(file).toString()) as ComposerLock
}

const parser: Parser = {
    parseDependencyTree: parseLockFile,
}

async function parseLockFile({root, manifestFile, lockFile}: DependencyFileContext): Promise<DepinderProject> {
    if(!manifestFile) {
        throw new Error('No manifest file found!')
    }
    const composer = parseComposerFile(path.join(root, manifestFile))
    let dependencies

    if (lockFile) {
        const composerLock = parseComposerLockFile(path.join(root, lockFile))
        dependencies = composerLock.packages.map(it => {
            const name = it.name
            const version = it.version
            const id = `${name}@${version}`
            const semver = getPackageSemver(version ?? '')
            const type = 'prod'
            const requestedBy: string[] = []
            return {
                id,
                name,
                version,
                semver,
                type,
                requestedBy,
            } as DepinderDependency
        }).reduce((acc, it) => {
            acc[it.id] = it
            return acc
        }, {} as { [id: string]: DepinderDependency })

        const allLibs = Object.values(dependencies)
        composerLock.packages.forEach(it => {
            Object.keys(it.require ?? {}).forEach(name => {
                const dep = allLibs.find(lib => lib.name === name)
                if (dep) {
                    dep.requestedBy.push(it.name)
                }
            })
        })

        Object.keys(composer.require ?? {}).forEach(name => {
            const dep = allLibs.find(lib => lib.name === name)
            if (dep) {
                dep.requestedBy.push(`${composer.name}@${composer.version}`)
            }
        })
    }



    if(dependencies == null) {
        // get dependencies from composer.json

        dependencies = {}
    }

    return {
        name: composer.name,
        version: composer.version || '',
        path: root,
        dependencies,
    }
}

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
            keywords: [],
        }
    }
}


const phpRegistrar: Registrar = new PackagistRegistrar(new LibrariesIORegistrar('packagist'))

const checker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'COMPOSER',
    getPURL: (lib, ver) => `pkg:composer/${lib.replace('@', '%40')}@${ver}`,
}

export const php: Plugin = {
    name: 'php',
    aliases: ['composer'],
    extractor,
    parser,
    registrar: phpRegistrar,
    checker,
}