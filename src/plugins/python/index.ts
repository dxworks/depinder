import {
    DependencyFileContext,
    DepinderDependency,
    DepinderProject,
    Extractor,
    Parser,
} from '../../extension-points/extract'
import path from 'path'
import {AbstractRegistrar, LibrariesIORegistrar, LibraryInfo, Registrar} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import {Plugin} from '../../extension-points/plugin'
import fs from 'fs'
import moment from 'moment'
import {execSync} from 'child_process'
import * as toml from 'toml'
import {getPackageSemver} from '../../utils/utils'
import {log} from '../../utils/logging'

const extractor: Extractor = {
    files: ['requirements.txt', 'setup.py', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock'],
    createContexts: files => {
        const pipEnvContexts = files.filter(it => it.endsWith('Pipfile.lock')).map(it => ({
            root: path.dirname(it),
            lockFile: path.basename(it),
            manifestFile: 'Pipfile',
        } as DependencyFileContext))

        const justPipFiles = files.filter(it => it.endsWith('Pipfile'))
            .filter(packageFile => !pipEnvContexts.some(it => it.root == path.dirname(packageFile)))
            .map(it => ({
                root: path.dirname(it),
                manifestFile: 'Pipfile',
            } as DependencyFileContext))
            .map(context => {
                try {
                    log.info(`Trying to generate lock file for ${context.root}`)
                    execSync('pipenv lock', {cwd: context.root})
                    return {
                        ...context,
                        lockFile: path.resolve(context.root, 'Pipfile.lock'),
                    }
                } catch (e: any) {
                    log.error(e)
                    return null
                }
            })
            .filter(it => it !== null)
            .map(it => it as DependencyFileContext)

        return [...pipEnvContexts, ...justPipFiles].map(context => {
                try {
                    if (!fs.existsSync(path.resolve(context.root, 'PipTree.json'))) {
                        execSync('pipenv install', {cwd: context.root})
                        const tree = execSync('pipenv graph --json', {cwd: context.root}).toString()
                        fs.writeFileSync(path.resolve(context.root, 'PipTree.json'), tree)
                    }
                    return {
                        ...context,
                        tree: path.resolve(context.root, 'PipTree.json'),
                    }
                } catch
                    (e: any) {
                    log.error(`Could not generate pipenv tree for project ${context.root}`, e)
                    return context
                }
            }
        )
    },
}

const parser: Parser = {
    parseDependencyTree: parseLockFile,
}

function transformDeps(tree: DepTreeEntry[]) {
    const cache = new Map<string, DepinderDependency>()

    function handleNode(node: DepTreeNode): DepinderDependency {
        const id = `${node.package_name}@${node.installed_version}`
        if (!cache.has(id)) {
            const newNode = {
                id,
                version: node.installed_version,
                name: node.package_name,
                requestedBy: [],
                semver: getPackageSemver(node.installed_version),
            } as DepinderDependency
            cache.set(id, newNode)
            return newNode
        } else {
            return cache.get(id)!
        }
    }

    tree.forEach(entry => {
        const node = handleNode(entry.package)
        entry.dependencies.forEach(dep => {
            const depNode = handleNode(dep)
            depNode.requestedBy.push(node.id)
        })
    })

    return Object.fromEntries(cache)
}

function parseLockFile(context: DependencyFileContext): DepinderProject {

    const projName = path.basename(context.root)
    let directDeps: string[] = []
    if (context.manifestFile === 'Pipfile') {
        try {
            const pipfile = toml.parse(fs.readFileSync(path.resolve(context.root, context.manifestFile)).toString())
            directDeps = Object.keys(pipfile.packages)
        } catch (e) {
            log.error(e)
        }

        let dependencies: { [id: string]: DepinderDependency } = {}

        // @ts-ignore
        const treePath = context.tree
        if (treePath) {
            const tree: DepTreeEntry[] = JSON.parse(fs.readFileSync(treePath).toString())
            dependencies = transformDeps(tree)

        } else {
            const lockFile: any = JSON.parse(fs.readFileSync(path.resolve(context.root, context.lockFile)).toString())
            dependencies = Object.entries<any>(lockFile.default).map(([name, obj]) => {
                const version = obj.version?.replace('==', '') ?? ''
                return ({
                    name,
                    id: `${name}@${version}`,
                    version: version,
                    path: context.root,
                    dependencies: {},
                    type: 'production',
                    requestedBy: [],
                    semver: getPackageSemver(version),
                } as DepinderDependency)
            }).reduce((acc, it) => {
                acc[it.id] = it
                return acc
            }, {} as { [id: string]: DepinderDependency })
        }

        const allDeps = Object.keys(dependencies)
        directDeps.forEach(dep => {
            const directDep = allDeps.find(it => it.startsWith(`${dep}@`))
            if (directDep) {
                if (dependencies[directDep]) {
                    dependencies[directDep].requestedBy.push(`${projName}@`)
                }
            }
        })
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies,
        }
    } else if (context.manifestFile === 'pyproject.toml') {
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies: {},
        }
    } else if (context.manifestFile === 'setup.py') {
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies: {},
        }
    } else if (context.manifestFile === 'requirements.txt') {
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies: {},
        }
    }
    throw new Error(`Unsupported manifest file ${JSON.stringify(context)}`)
}

const checker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'PIP',
    getPURL: (lib, ver) => `pkg:pypi/${lib.replace('@', '%40')}@${ver}`,
}

interface DepTreeNode {
    key: string,
    package_name: string,
    installed_version: string,
    required_version?: string,
}

export interface DepTreeEntry {
    package: DepTreeNode,
    dependencies: DepTreeNode[],
}

class PyPiRegistrar extends AbstractRegistrar {
    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const pypiURL = `https://pypi.org/pypi/${libraryName}/json`
        const pypiResponse: any = await fetch(pypiURL)
        const pypiData = await pypiResponse.json()
        return {
            name: libraryName,
            versions: Object.entries<any[]>(pypiData.releases).map(([ver, it]) => {
                return {
                    version: ver,
                    timestamp: it.length > 0 ? moment(it[0].upload_time).valueOf() : 0,
                    latest: ver === pypiData.info.version,
                    licenses: [],
                }
            }),
            description: pypiData.info.description ?? pypiData.info.summary ?? '',
            licenses: pypiData.info.license ? [pypiData.info.license] : [],
            homepageUrl: pypiData.info.home_page ?? '',
            keywords: pypiData.info.keywords ?? [],
            authors: pypiData.info.author ? [pypiData.info.author] : [],
            issuesUrl: pypiData.info.bugtrack_url ?? '',
            downloads: pypiData.info.downloads?.last_month ?? 0,
            packageUrl: pypiData.info.package_url ?? '',
        }
    }
}

export const pythonRegistrar: Registrar = new PyPiRegistrar(new LibrariesIORegistrar('pypi'))

export const python: Plugin = {
    name: 'python',
    aliases: ['pip', 'pipenv', 'poetry'],
    extractor,
    parser,
    registrar: pythonRegistrar,
    checker,
}
