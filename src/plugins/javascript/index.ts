import {
    DependencyFileContext,
    DepinderDependency,
    DepinderProject,
    Extractor,
    Parser,
} from '../../extension-points/extract'
import {buildDepTreeFromFiles} from 'snyk-nodejs-lockfile-parser'
import path from 'path'
import {SemVer} from 'semver'
import {DepTreeDep} from 'snyk-nodejs-lockfile-parser/dist/parsers'
import {LibraryInfo, Registrar} from '../../extension-points/registrar'
import {json} from 'npm-registry-fetch'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import {Plugin} from '../../extension-points/plugin'
import {npm} from '../../utils/npm'
import fs from 'fs'
import {log} from '../../utils/logging'

const extractor: Extractor = {
    files: ['package.json', 'package-lock.json', 'yarn.lock'],
    createContexts: files => {
        const lockFileContexts = files.filter(it => it.endsWith('package-lock.json') || it.endsWith('yarn.lock')).map(it => ({
            root: path.dirname(it),
            lockFile: path.basename(it),
            manifestFile: 'package.json',
        } as DependencyFileContext))

        const packageJsonWithLockInParent = files.filter(it => it.endsWith('package.json'))
            .filter(packageFile => !lockFileContexts.some(it => it.root == path.dirname(packageFile)))
            .filter(packageFile => getParentLockFile(packageFile) !== null)
            .map(it => ({
                root: path.dirname(it),
                manifestFile: 'package.json',
                lockFile: getParentLockFile(it),
            } as DependencyFileContext))


        const justPackageJson = files.filter(it => it.endsWith('package.json'))
            .filter(packageFile => !lockFileContexts.some(it => it.root == path.dirname(packageFile)))
            .filter(packageFile => !packageJsonWithLockInParent.some(it => it.root == path.dirname(packageFile)))
            .map(it => ({
                root: path.dirname(it),
                manifestFile: 'package.json',
            } as DependencyFileContext))
            .map(context => {
                try {
                    log.info(`Trying to generate lock file for ${context.root}`)
                    npm.install('', '--package-lock-only', context.root)
                    return {
                        ...context,
                        lockFile: path.resolve(context.root, 'package-lock.json'),
                    }
                } catch (e: any) {
                    log.error(e)
                    return null
                }
            })
            .filter(it => it !== null)
            .map(it => it as DependencyFileContext)

        return [...lockFileContexts, ...justPackageJson, ...packageJsonWithLockInParent]
    },
    filter: it => !it.includes('node_modules'),
}


function getParentLockFile(packageFile: string, maxDepth = 5): string | null {
    const dir = path.dirname(packageFile)
    if (maxDepth < 0)
        return null
    if (fs.existsSync(path.resolve(dir, 'package-lock.json')))
        return path.resolve(dir, 'package-lock.json')
    if (fs.existsSync(path.resolve(dir, 'yarn.lock')))
        return path.resolve(dir, 'yarn.lock')
    return getParentLockFile(dir, maxDepth - 1)
}

const parser: Parser = {
    parseDependencyTree: parseLockFile,
}

function recursivelyTransformDeps(tree: DepTreeDep, result: Map<string, DepinderDependency>) {
    const rootId = `${tree.name}@${tree.version}`
    Object.values(tree.dependencies ?? {}).forEach(dep => {
        const id = `${dep.name}@${dep.version}`
        const cachedVersion = result.get(id)
        if (cachedVersion) {
            cachedVersion.requestedBy = [rootId, ...cachedVersion.requestedBy]
        } else {
            try {
                const semver = new SemVer(dep.version ?? '', true)
                result.set(id, {
                    id,
                    version: dep.version,
                    name: dep.name,
                    semver: semver,
                    requestedBy: [rootId],
                } as DepinderDependency)
            } catch (e) {
                log.warn(`Invalid version! ${e}`)
            }
        }
        recursivelyTransformDeps(dep, result)
    })
}

function transformDeps(tree: DepTreeDep, root: string): Map<string, DepinderDependency> {
    log.info(`Starting recursive transformation for ${root}`)
    const result: Map<string, DepinderDependency> = new Map<string, DepinderDependency>()
    recursivelyTransformDeps(tree, result)
    log.info(`End recursive transformation for ${root}.`)
    return result
}

async function parseLockFile({root, manifestFile, lockFile}: DependencyFileContext): Promise<DepinderProject> {
    // const lockFileVersion = getLockfileVersionFromFile(lockFile)
    // log.info(`parsing ${path.resolve(root, lockFile)}`)
    const result = await buildDepTreeFromFiles(root, manifestFile ?? 'package.json', lockFile ?? '', true, false)

    const manifestJSON = JSON.parse(fs.readFileSync(path.resolve(root, manifestFile ?? 'package.json'), 'utf8'))
    return {
        path: path.resolve(root, manifestFile ?? 'package.json'),
        name: result.name ?? manifestJSON.name,
        version: result.version ?? manifestJSON.version,
        dependencies: Object.fromEntries(transformDeps(result, root)),
    }
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
        licenses: [response.license],
        reposUrl: [],
        keywords: response.keywords,
    }
}

const registrar: Registrar = {
    retrieve: retrieveFromNpm,
}

const checker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'NPM',
    getPURL: (lib, ver) => `pkg:npm/${lib.replace('@', '%40')}@${ver}`,
}

export const javascript: Plugin = {
    name: 'npm',
    aliases: ['js', 'javascript', 'node', 'nodejs', 'yarn'],
    extractor,
    parser,
    registrar,
    checker,
}

