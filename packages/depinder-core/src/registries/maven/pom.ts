import {HttpError} from '../../http/client.js'
import {errorMessage} from '../../log.js'
import {normaliseLicenses, normaliseRepoUrl, stringOrUndefined} from '../normalise.js'
import type {FetchContext, FetchedVersion} from '../types.js'
import {artifactBase, child, list, seg, SOURCE, textOf, trustedRelease, xml} from './metadata.js'

/** How many versions to try a POM for before giving up on library-level metadata. */
const MAX_POM_TRIES = 5
/** How far up a `<parent>` chain to walk for inherited licenses. */
const MAX_PARENT_DEPTH = 5

interface MavenPom {
    licenses: string[]
    description?: string
    url?: string
    repoUrl?: string
    parent?: {groupId: string; artifactId: string; version: string}
}

/**
 * The POM the library-level facts come from: the newest version that is not a pre-release, with a
 * trusted `<release>` tried first because that is Central's own designation.
 *
 * Two things end the search early, and neither of them is "a POM came back". A version whose POM
 * is missing (it happens: a `.pom`-less deploy) falls through to the next candidate, and so does a
 * POM that declares no licence and inherits none — commons-collections' `20040616` POM is five
 * elements long and has neither `<licenses>` nor `<parent>`, so stopping there would blank the
 * licence for the whole artifact. The first POM read is kept as a fallback: when no candidate has
 * a licence, its description and URLs are still the best library-level facts on offer.
 *
 * The walk is capped by `pomCandidates` at `MAX_POM_TRIES`, so an artifact that genuinely declares
 * no licence anywhere costs five requests, not one per version.
 */
export async function fetchLibraryPom(
    base: string,
    artifactId: string,
    versions: readonly FetchedVersion[],
    release: string | undefined,
    ctx: FetchContext,
): Promise<MavenPom | null> {
    let fallback: MavenPom | null = null

    for (const version of pomCandidates(versions, release)) {
        const pom = await fetchPom(pomUrl(base, artifactId, version), ctx)
        if (!pom) continue
        const merged = await inheritFromParents(pom, ctx)
        if (merged.licenses.length > 0) return merged
        fallback ??= merged
    }
    return fallback
}

/**
 * Newest first, `MAX_POM_TRIES` of them. Undated versions sort last, newest-listed first.
 *
 * `<release>` jumps the queue only when `trustedRelease` vouches for it — that is what keeps the
 * licence of an artifact with a stale metadata file from being read out of a decade-old POM, while
 * still honouring Central's choice between guava's two co-shipped flavours. A `<release>` that is
 * not trusted is not dropped, it just takes its place in the deploy order.
 */
export function pomCandidates(versions: readonly FetchedVersion[], release: string | undefined): string[] {
    const stable = versions.filter(v => !v.prerelease)
    const usable = stable.length > 0 ? stable : versions
    const ordered = [...usable].reverse()
    ordered.sort((a, b) => (b.releasedAt?.getTime() ?? 0) - (a.releasedAt?.getTime() ?? 0))

    const trusted = trustedRelease(versions, release)
    const names = ordered.map(v => v.version)
    if (trusted && names.includes(trusted)) names.unshift(trusted)
    return [...new Set(names)].slice(0, MAX_POM_TRIES)
}

function pomUrl(base: string, artifactId: string, version: string): string {
    return `${base}/${seg(version)}/${seg(`${artifactId}-${version}.pom`)}`
}

/** `null` for a 404, so the caller can try the next version or stop the parent walk. */
async function fetchPom(url: string, ctx: FetchContext): Promise<MavenPom | null> {
    const response = await ctx.http.get(url, {headers: {accept: 'application/xml'}})
    if (response.status === 404) return null
    if (!response.ok) {
        throw new HttpError(`${SOURCE} returned ${response.status} for ${url}`, response.url, response.status)
    }
    return parsePom(response.text)
}

/**
 * Most POMs declare nothing themselves: guava's `<licenses>` and `<scm>` live in `guava-parent`.
 * So when the licenses or the homepage are missing, walk `<parent>` upwards, taking only the
 * fields that are still missing, at most `MAX_PARENT_DEPTH` hops.
 */
async function inheritFromParents(pom: MavenPom, ctx: FetchContext): Promise<MavenPom> {
    let merged = pom
    let current = pom

    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
        if (merged.licenses.length > 0 && merged.url) break
        const url = current.parent && parentPomUrl(current.parent)
        if (!url) break
        const parent = await fetchPom(url, ctx)
        if (!parent) break
        merged = {
            licenses: merged.licenses.length > 0 ? merged.licenses : parent.licenses,
            description: merged.description ?? parent.description,
            url: merged.url ?? parent.url,
            repoUrl: merged.repoUrl ?? parent.repoUrl,
            parent: merged.parent,
        }
        current = parent
    }
    return merged
}

/** `null` when the coordinates are not usable as a URL — an unresolved `${...}` property, say. */
function parentPomUrl(parent: {groupId: string; artifactId: string; version: string}): string | null {
    const {groupId, artifactId, version} = parent
    if (!groupId || !artifactId || !version) return null
    if ([groupId, artifactId, version].some(v => v.includes('${'))) return null
    return pomUrl(artifactBase({namespace: groupId, name: artifactId}), artifactId, version)
}

export function parsePom(text: string): MavenPom {
    const project = child(xml.parse(text), 'project')
    if (project == null) return {licenses: []}

    const licenseNodes = list(child(child(project, 'licenses'), 'license'))
    // `<name>` is what a POM is supposed to carry; a few only give the `<url>` of the license text.
    const names = licenseNodes.map(node => textOf(child(node, 'name')) ?? textOf(child(node, 'url')))

    const scm = child(project, 'scm')
    const scmUrl = textOf(child(scm, 'url')) ?? textOf(child(scm, 'connection'))

    return {
        licenses: normaliseLicenses(names),
        // POM descriptions are hand-wrapped prose in an XML element; the line breaks and the
        // indentation that came with them are not part of the description.
        description: stringOrUndefined(textOf(child(project, 'description'))?.replace(/\s+/g, ' ')),
        url: stringOrUndefined(textOf(child(project, 'url'))),
        repoUrl: normaliseRepoUrl(stripScmPrefix(scmUrl)),
        parent: readParent(child(project, 'parent')),
    }
}

function readParent(node: unknown): MavenPom['parent'] {
    if (node == null) return undefined
    const groupId = textOf(child(node, 'groupId'))
    const artifactId = textOf(child(node, 'artifactId'))
    const version = textOf(child(node, 'version'))
    if (!groupId || !artifactId || !version) return undefined
    return {groupId, artifactId, version}
}

/** `scm:git:https://github.com/x/y.git` -> `https://github.com/x/y.git`, for `normaliseRepoUrl`. */
function stripScmPrefix(value: string | undefined): string | undefined {
    return value?.replace(/^scm:[A-Za-z0-9+._-]+:/, '')
}

/**
 * `MAVEN_PER_VERSION_LICENSES`: a POM per version, sequentially, because an artifact with 300
 * versions is 300 requests and the point of the flag is that you opted into paying for them. No
 * parent walk here — that would multiply the cost again — so a version whose POM inherits its
 * licenses falls back to the library-level list, which is where the parent walk already looked.
 */
export async function fillPerVersionLicenses(
    base: string,
    artifactId: string,
    versions: FetchedVersion[],
    fallback: string[],
    ctx: FetchContext,
): Promise<void> {
    for (const version of versions) {
        let own: string[] = []
        try {
            const pom = await fetchPom(pomUrl(base, artifactId, version.version), ctx)
            own = pom?.licenses ?? []
        } catch (e) {
            // One unreadable POM out of hundreds is not worth failing the package for.
            ctx.log.debug('per-version POM failed', {version: version.version, error: errorMessage(e)})
        }
        version.licenses = own.length > 0 ? own : fallback
    }
}
