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
 * Exported so the field can be read from a pom fetched outside the registrar.
 */
export function mavenProjectUrl(pomXml: string): string {
    const url = new XMLParser().parse(pomXml)?.project?.url
    return typeof url === 'string' ? url.trim() : ''
}

/** `mavenProjectUrl`, with the parent chain walked when the pom itself names no `<url>`. */
export async function mavenProjectUrlInherited(pomXml: string): Promise<string> {
    const pom = await inheritFromParents(new XMLParser().parse(pomXml))
    return typeof pom?.project?.url === 'string' ? pom.project.url.trim() : ''
}

/** `<licenses>` as an array of names, whether the pom declares one licence or several. */
function pomLicenseNames(pom: any): string[] {
    const declared = pom?.project?.licenses?.license
    const list = Array.isArray(declared) ? declared : declared ? [declared] : []
    return list.map((it: any) => it?.name).filter((it: any): it is string => typeof it === 'string' && !!it.trim())
}

/**
 * `<licenses>` and `<url>` are inherited: a pom that declares neither means "the same as my
 * parent", and most of Apache, Google and Spring declare them once, in a parent pom several levels
 * up (`commons-text` says nothing, `commons-parent` says Apache 2.0). On the run this was written
 * for, 159 of 534 Maven components had no licence and 48 no link for exactly that reason. Only the
 * two fields are inherited here, and only while they are missing; the parent's `<url>` is taken as
 * written, not with the child's artifactId appended the way Maven's effective pom does, because
 * the project page is the parent's. Five levels is deeper than any real chain.
 */
export async function inheritFromParents(pom: any, depth = 5): Promise<any> {
    const project = pom?.project
    const parent = project?.parent
    if (!project || !parent?.groupId || !parent?.artifactId || !parent?.version || depth === 0) return pom
    if (pomLicenseNames(pom).length > 0 && typeof project.url === 'string' && project.url.trim()) return pom
    const url = `https://repo1.maven.org/maven2/${String(parent.groupId).replace(/\./g, '/')}/${parent.artifactId}/${parent.version}/${parent.artifactId}-${parent.version}.pom`
    let parentPom: any
    try {
        const response = await fetch(url)
        if (response.status !== 200) return pom
        parentPom = await inheritFromParents(new XMLParser().parse(await response.text()), depth - 1)
    } catch {
        return pom
    }
    const merged = {...pom, project: {...project}}
    if (pomLicenseNames(pom).length === 0 && parentPom?.project?.licenses) merged.project.licenses = parentPom.project.licenses
    if (!(typeof project.url === 'string' && project.url.trim()) && typeof parentPom?.project?.url === 'string') merged.project.url = parentPom.project.url
    return merged
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

/**
 * The solr search index, `search.maven.org`. Second in the chain since 2026-09-14: its version
 * list can be silently incomplete (see `MavenRepositoryRegistrar`), so it is only asked when the
 * repository itself cannot answer.
 */
export class MavenCentralRegistrar extends AbstractRegistrar {
    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const [groupId, artifactId] = libraryName.split(':')

        const abortController = new AbortController()
        const abortTimer = setTimeout(() => abortController.abort(), 10000)
        // Timer cleared on every exit, so a script that asks for hundreds of artifacts in a row
        // does not keep the process alive ten seconds past its last answer.
        try {
            return await this.retrieveVersions(groupId, artifactId, libraryName, abortController.signal)
        } finally {
            clearTimeout(abortTimer)
        }
    }

    /**
     * The solr `gav` core, one page of 200 versions at a time. The search URL is built per page:
     * it used to be built once with `start=0`, so every page after the first re-read the first,
     * and an artifact with more than 200 versions came back with its first page repeated.
     *
     * `search.maven.org` throttles concurrent callers, not sequential ones: 8 requests at once
     * abort every one of them after the first, one at a time with a pause answers every artifact
     * (measured on this run's 432 missed Java components). The politeness lives in the caller.
     */
    private async retrieveVersions(groupId: string, artifactId: string, libraryName: string, signal: AbortSignal): Promise<LibraryInfo> {
        const rows = 200
        const searchURL = (start: number) =>
            `https://search.maven.org/solrsearch/select?q=g:"${groupId}" AND a:"${artifactId}"&core=gav&wt=json&rows=${rows}&start=${start}`
        const mavenResponse: any = await fetch(searchURL(0), {signal})
        const mavenData = await mavenResponse.json()
        let docs = mavenData.response.docs

        while (docs.length < mavenData.response.numFound) {
            const pageResponse: any = await fetch(searchURL(docs.length), {signal})
            const pageData = await pageResponse.json()
            if (!pageData.response.docs.length) break
            docs = [...docs, ...pageData.response.docs]
        }

        let pom: any
        try {
            pom = await inheritFromParents((await this.getPom(groupId, artifactId, docs, libraryName)).pomObject)
        } catch (e) {
            log.warn(`Failed to get pom for ${libraryName}`)
            throw e
        }
        return libraryInfoFrom(libraryName, docs.map((it: any) => ({version: it.v, timestamp: it.timestamp})), pom)
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

/**
 * The registry's own answer, whichever service produced the version list: the solr search index
 * or the repository listing. `versions` arrives newest first; the first one is `latest`, as it
 * was when only the search index answered.
 */
function libraryInfoFrom(libraryName: string, versions: {version: string, timestamp: number}[], pom: any): LibraryInfo {
    return {
        name: libraryName,
        versions: versions.map(it => ({
            version: it.version,
            timestamp: it.timestamp,
            latest: it.version === versions[0]?.version,
            licenses: [],
        })),
        description: pom?.project?.description ?? '',
        licenses: pomLicenseNames(pom),
        reposUrl: pom?.project?.scm ? [pom?.project.scm.connection] : [],
        issuesUrl: pom?.project?.issueManagement?.url ? [pom?.project.issueManagement.url] : [],
        homepageUrl: typeof pom?.project?.url === 'string' ? pom.project.url.trim() : '',
    }
}

/**
 * One row of a `repo1.maven.org` directory listing: the version directory and the date the
 * repository stamps next to it. Exported so the parser can be tested against a captured listing.
 */
export function parseRepositoryListing(html: string): {version: string, timestamp: number}[] {
    const rows: {version: string, timestamp: number}[] = []
    for (const match of html.matchAll(/href="([^"/]+)\/"[^\n]*?(\d{4}-\d\d-\d\d \d\d:\d\d)/g)) {
        const timestamp = Date.parse(`${match[2].replace(' ', 'T')}:00Z`)
        if (!isNaN(timestamp)) rows.push({version: match[1], timestamp})
    }
    return rows.sort((a, b) => b.timestamp - a.timestamp)
}

/**
 * Maven Central through the repository itself, `repo1.maven.org` — the registrar of record for
 * Java, ahead of the search index.
 *
 * The solr index behind `search.maven.org` lags the repository, and it lags in two ways. It can
 * answer `numFound: 0` for an artifact whose poms have been on `repo1.maven.org` for months (46 of
 * 432 Java components on the twelve-repository run — every Spring Boot 4 module,
 * `selenium-devtools-v145` and later). Worse, it can answer with a *truncated* list and no sign
 * of it: on 2026-09-14 it knew 45 versions of `httpclient5` ending at `5.6.1` (April) while the
 * repository had `5.6.2`–`5.6.4` and `5.7-alpha1` (August), and knew only the four `3.0.0-rc*` of
 * `tools.jackson.core:jackson-core` while `3.0.0`–`3.2.2` were released. A fallback that only
 * fires on failure never sees the second case, and the upgrade guidance built on that list
 * recommended nothing for three vulnerable artifacts whose fix existed. Hence the order: the
 * repository answers first, the search index only when the repository cannot.
 *
 * The repository's directory listing names each version with the minute it was deployed, and that
 * date is the search index's `timestamp` to the minute (checked on `slf4j-api` 2.0.9: solr
 * `2023-09-03T16:14:33Z`, listing `2023-09-03 16:14`, pom `Last-Modified` the same second). One
 * request for the metadata, one for the listing and one for the pom is the whole answer, and the
 * repository does not throttle the way the search service does.
 *
 * `maven-metadata.xml` is the version list of record: a listing row that the metadata does not
 * name is not a released version.
 */
export class MavenRepositoryRegistrar extends AbstractRegistrar {
    protected baseURL = 'https://repo1.maven.org/maven2'

    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        const [groupId, artifactId] = libraryName.split(':')
        const artifactURL = `${this.baseURL}/${groupId.replace(/\./g, '/')}/${artifactId}`

        const metadata = await fetch(`${artifactURL}/maven-metadata.xml`)
        if (metadata.status !== 200) throw new Error(`No maven-metadata.xml for ${libraryName} on repo1.maven.org (${metadata.status})`)
        const released = new Set([...(await metadata.text()).matchAll(/<version>([^<]+)<\/version>/g)].map(it => it[1]))

        const listing = await fetch(`${artifactURL}/`)
        if (listing.status !== 200) throw new Error(`No listing for ${libraryName} on repo1.maven.org (${listing.status})`)
        const versions = parseRepositoryListing(await listing.text()).filter(it => released.has(it.version))
        if (!versions.length) throw new Error(`No versions for ${libraryName} on repo1.maven.org`)

        let pom: any
        for (const {version} of versions) {
            const response = await fetch(`${artifactURL}/${version}/${artifactId}-${version}.pom`)
            if (response.status === 200) {
                pom = await inheritFromParents(new XMLParser().parse(await response.text()))
                break
            }
        }
        if (!pom) {
            log.warn(`Failed to get pom for ${libraryName}`)
            throw new Error(`No pom for ${libraryName} on repo1.maven.org`)
        }
        return libraryInfoFrom(libraryName, versions, pom)
    }
}

export const javaRegistrar = new MavenRepositoryRegistrar(new MavenCentralRegistrar(new LibrariesIORegistrar('maven')))

export const java: Plugin = {
    name: 'java',
    aliases: ['maven', 'gradle'],
    extractor,
    parser,
    registrar: javaRegistrar,
    checker,
}

