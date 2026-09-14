import {DependencyFileContext, DepinderProject, Extractor, Parser} from '../../extension-points/extract'
// @ts-ignore
import path from 'path'
import {AbstractRegistrar, LibrariesIORegistrar, LibraryInfo} from '../../extension-points/registrar'
import {VulnerabilityChecker} from '../../extension-points/vulnerability-checker'
import {Plugin} from '../../extension-points/plugin'
import fs from 'fs'
import {depinderTempFolder} from '../../utils/utils'
import {parseMavenDependencyTree} from './parsers/maven'
import {log} from '../../utils/logging'

import {XMLParser} from 'fast-xml-parser'

const extractor: Extractor = {
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    createContexts: files => {

        const pomContexts = files.filter(it => it.endsWith('pom.xml')).map(it => ({
            root: path.dirname(it),
            lockFile: 'deptree.txt',
            type: 'maven',
        } as DependencyFileContext))

        const gradleContexts = files.filter(it => it.endsWith('build.gradle') || it.endsWith('build.gradle.kts')).map(it => ({
            root: path.dirname(it),
            manifestFile: path.basename(it),
            lockFile: 'gradle.json',
            type: 'gradle',
        }) as DependencyFileContext)

        return [...pomContexts, ...gradleContexts]
    },
}

const parser: Parser = {
    parseDependencyTree: parseLockFile,
}

function parseLockFile(context: DependencyFileContext): DepinderProject {
    if(context.type === 'maven') {
        if(!fs.existsSync(path.resolve(context.root, context.lockFile))) {
            throw new Error(`Dependency tree file not found: ${path.resolve(context.root, context.lockFile)}`)
        }
        const depTreeContent = fs.readFileSync(path.resolve(context.root, context.lockFile)).toString()

        const depinderProject = parseMavenDependencyTree(depTreeContent)
        depinderProject.path = path.resolve(context.root, context.manifestFile??'pom.xml')
        return depinderProject
    }
    else if(context.type === 'gradle') {
        throw new Error(`Unsupported context type: ${context.type}. Gradle is not supported yet!`)
    }
    // if (context.type === 'maven-with-dep-tree') {
    //     return JSON.parse(fs.readFileSync(path.resolve(context.root, context.lockFile)).toString()) as DepinderProject
    // }
    //
    // if (context.type === 'gradle') {
    //     if (fs.existsSync(path.resolve(context.root, context.lockFile))) {
    //         const proj = JSON.parse(fs.readFileSync(path.resolve(context.root, context.lockFile)).toString()) as DepinderProject
    //         return {
    //             ...proj,
    //             dependencies: Object.entries(proj.dependencies).filter(([, value]) =>
    //                 value.requestedBy.includes(`${proj.name}@${proj.version}`)
    //             ).reduce((acc, [key, value]) => ({...acc, [key]: value}), {}),
    //         }
    //     }
    // }

    throw new Error(`Unsupported context type: ${context.type}`)
}

function parsePomFile(pomFile: string): any {
    return {pomObject: new XMLParser().parse(fs.readFileSync(pomFile, 'utf-8'))}
}

/**
 * `Component Link` for a Maven component: the pom's own `<url>`, the project the artifact belongs
 * to. On 43 sampled components that Black Duck has a link for it agreed 35% of the time, against
 * 16% for `<scm><url>`.
 *
 * Exported because the offline `refresh-component-link.cjs` has to read this field from a pom it
 * fetched itself — Maven Central's *search* service throttles a sweep to a standstill, while the
 * repository that serves the poms does not — and reading it through this function is what keeps
 * the two answers the same field parsed the same way.
 */
export function mavenProjectUrl(pomXml: string): string {
    const url = new XMLParser().parse(pomXml)?.project?.url
    return typeof url === 'string' ? url.trim() : ''
}

async function getLatestAvailablePom(groupId: string, artifactId: string, docs: any[]): Promise<any> {
    for (let i = 0; i < docs.length; i++) {
        const pomUrl = `https://search.maven.org/remotecontent?filepath=${groupId.replace(/\./g, '/')}/${artifactId}/${docs[i].v}/${artifactId}-${docs[i].v}.pom`
        const pomResponse: any = await fetch(pomUrl)
        if (pomResponse.status === 200)
            return pomResponse
    }
}

const checker: VulnerabilityChecker = {
    githubSecurityAdvisoryEcosystem: 'MAVEN',
    getPURL: (lib, ver) => `pkg:maven/${lib.replace(':', '/')}@${ver}`,
}

export class MavenCentralRegistrar extends AbstractRegistrar {
    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const [groupId, artifactId] = libraryName.split(':')

        const abortController = new AbortController()
        setTimeout(() => abortController.abort(), 10000)

        const rows = 200
        let start = 0
        const mavenSearchURL = `https://search.maven.org/solrsearch/select?q=g:"${groupId}" AND a:"${artifactId}"&core=gav&wt=json&rows=${rows}&start=${start}`
        const mavenResponse: any = await fetch(mavenSearchURL, {signal: abortController.signal})
        const mavenData = await mavenResponse.json()
        let docs = mavenData.response.docs

        while (docs.length < mavenData.response.numFound) {
            start += rows
            const mavenResponse: any = await fetch(mavenSearchURL, {signal: abortController.signal})
            const mavenData = await mavenResponse.json()
            docs = [...docs, ...mavenData.response.docs]
        }

        let pom: any
        try {
            pom = (await this.getPom(groupId, artifactId, docs, libraryName)).pomObject
        } catch (e) {
            log.warn(`Failed to get pom for ${libraryName}`)
            throw e
        }
        return {
            name: libraryName,
            versions: docs.map((it: any) => {
                return {
                    version: it.v,
                    timestamp: it.timestamp,
                    latest: it.v === docs[0].v,
                    licenses: [],
                }
            }),
            description: pom?.project?.description ?? '',
            licenses: pom?.project?.licenses?.license ? [pom?.project.licenses.license.name] : [],
            reposUrl: pom?.project?.scm ? [pom?.project.scm.connection] : [],
            issuesUrl: pom?.project?.issueManagement?.url ? [pom?.project.issueManagement.url] : [],
            homepageUrl: typeof pom?.project?.url === 'string' ? pom.project.url.trim() : '',
        }
    }

    async getPom(groupId: string, artifactId: string, docs: string[], libraryName: string): Promise<any> {
        const pomResponse = await getLatestAvailablePom(groupId, artifactId, docs)
        const pomData = await pomResponse.text()

        const pomFile = path.resolve(depinderTempFolder, `${libraryName}.pom`)
        fs.writeFileSync(pomFile, pomData)

        const pom: any = parsePomFile(pomFile)
        fs.rmSync(pomFile)
        return pom
    }
}

const javaRegistrar = new MavenCentralRegistrar(new LibrariesIORegistrar('maven'))

export const java: Plugin = {
    name: 'java',
    aliases: ['maven', 'gradle'],
    extractor,
    parser,
    registrar: javaRegistrar,
    checker,
}

