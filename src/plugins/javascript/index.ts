import {
    DependencyFileContext,
    DepinderDependency,
    DepinderProject,
    Extractor,
    Parser,
} from '../../extension-points/extract'
import {
    buildDepTreeFromFiles,
    getLockfileVersionFromFile,
    NodeLockfileVersion,
    parseNpmLockV2Project
} from 'snyk-nodejs-lockfile-parser'
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
import {GraphNode} from '@snyk/dep-graph/dist/core/types'

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

function recursivelyTransformTreeDeps(tree: DepTreeDep, result: Map<string, DepinderDependency>) {
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
        recursivelyTransformTreeDeps(dep, result)
    })
}

function transformGraphDepsFlat(rootId: string, dependencies: GraphNode[] , result: Map<string, DepinderDependency>) {
    dependencies.forEach(dependency => {
        const lastAt = dependency.nodeId.lastIndexOf('@')
        const name = dependency.nodeId.slice(0, lastAt)
        const version = dependency.nodeId.slice(lastAt + 1)
        const id = `${name}@${version}`
        const cachedVersion = result.get(id)
        if (cachedVersion) {
            cachedVersion.requestedBy = [rootId, ...cachedVersion.requestedBy]
        } else {
            try {
                const semver = new SemVer(version ?? '', true)
                result.set(id, {
                    id,
                    version: version,
                    name: name,
                    semver: semver,
                    requestedBy: [rootId],
                } as DepinderDependency)
            } catch (e) {
                log.warn(`Invalid version! ${e}`)
            }
        }

        dependency.deps.forEach((transitiveDep) => {
            const lastAt = transitiveDep.nodeId.lastIndexOf('@')
            const name = transitiveDep.nodeId.slice(0, lastAt)
            const version = transitiveDep.nodeId.slice(lastAt + 1)
            const id = `${name}@${version}`
            const cachedVersion = result.get(id)
            if (cachedVersion) {
                cachedVersion.requestedBy = [dependency.nodeId, ...cachedVersion.requestedBy]
            } else {
                try {
                    const semver = new SemVer(version ?? '', true)
                    result.set(id, {
                        id,
                        version: version,
                        name: name,
                        semver: semver,
                        requestedBy: [dependency.nodeId],
                    } as DepinderDependency)
                } catch (e) {
                    log.warn(`Invalid version! ${e}`)
                }
            }

        })
    })
}

function transformTreeDeps(tree: DepTreeDep, root: string): Map<string, DepinderDependency> {
    log.info(`Starting recursive transformation for ${root}`)
    const result: Map<string, DepinderDependency> = new Map<string, DepinderDependency>()
    recursivelyTransformTreeDeps(tree, result)
    log.info(`End recursive transformation for ${root}.`)
    return result
}

function transformGraphDeps(depGraphNodes: GraphNode[], root: string): Map<string, DepinderDependency> {
    log.info(`Starting recursive transformation for ${root}`)
    const result: Map<string, DepinderDependency> = new Map<string, DepinderDependency>()
    transformGraphDepsFlat(depGraphNodes[0].pkgId, depGraphNodes, result)
    log.info(`End recursive transformation for ${root}.`)
    return result
}

async function parseLockFile({root, manifestFile, lockFile}: DependencyFileContext): Promise<DepinderProject> {
    const manifestFilePath = path.resolve(root, manifestFile ?? 'package.json')
    const lockFilePath = path.resolve(root, lockFile)
    const lockFileVersion : NodeLockfileVersion = getLockfileVersionFromFile(lockFilePath)
    switch (lockFileVersion) {
        case NodeLockfileVersion.YarnLockV1:
        case NodeLockfileVersion.YarnLockV2:
        case NodeLockfileVersion.NpmLockV1: {
            const result = await buildDepTreeFromFiles(root, manifestFile ?? 'package.json', lockFile ?? '', true, false)

            const manifestJSON = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8'))
            return {
                path: manifestFilePath,
                name: result.name ?? manifestJSON.name,
                version: result.version ?? manifestJSON.version,
                dependencies: Object.fromEntries(transformTreeDeps(result, root)),
            }
        }
        case NodeLockfileVersion.NpmLockV2:
        case NodeLockfileVersion.NpmLockV3: {
            // const oldResult = await buildDepTreeFromFiles(root, manifestFile ?? 'package.json', lockFile ?? '', true, false)
            const manifestFileContent = fs.readFileSync(manifestFilePath, 'utf8')
            const lockFileContent = fs.readFileSync(lockFilePath, 'utf8')
            const result = await parseNpmLockV2Project(manifestFileContent, lockFileContent, {
                includeDevDeps: true,
                strictOutOfSync: false,
                includeOptionalDeps: false,
                pruneCycles: true,
                includePeerDeps: false,
                pruneNpmStrictOutOfSync: false
            })
            const manifestJSON = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8'))
            return {
                path: manifestFilePath,
                name: result.rootPkg.name ?? manifestJSON.name,
                version: result.rootPkg.version ?? manifestJSON.version,
                dependencies: Object.fromEntries(transformGraphDeps(result.toJSON().graph.nodes, root)),
            }

        }
        case NodeLockfileVersion.PnpmLockV5:
        case NodeLockfileVersion.PnpmLockV6:
        case NodeLockfileVersion.PnpmLockV9:
        default: {
            throw new Error(`Lockfile version ${lockFileVersion} is not supported by Depinder. Please use npm v1 / v2 / v3 or yarn v1 / v2`)
        }
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

