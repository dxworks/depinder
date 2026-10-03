import {HttpError} from '../../http/client.js'
import {registryName, type ParsedPurl} from '../../purl.js'
import {isPrerelease} from '../latest.js'
import type {FetchedVersion, PackageFetcher} from '../types.js'
import {artifactBase, fetchReleaseDates, parseMetadata, SOURCE, trustedRelease} from './metadata.js'
import {fetchLibraryPom, fillPerVersionLicenses} from './pom.js'

/**
 * maven — facts from repo1.maven.org, the registry of record. Never search.maven.org: it is a
 * search index over the repository, not the repository, and it lags it.
 *
 * Maven Central publishes no per-package JSON, so one artifact costs three kinds of request:
 *
 *  - `maven-metadata.xml` for the version list (and `<release>`, see `registryLatest` below);
 *  - the HTML directory listing for the deploy timestamp of each version, which is the only place
 *    Central states when something was published;
 *  - the POM of one version for the licenses, description, homepage and SCM URL, following
 *    `<parent>` upwards when the child inherits them (which most POMs do), and dropping to the
 *    next version down when a POM is missing or declares no licence at all.
 *
 * That is three requests for an artifact whose newest POM answers, not three per version — unless
 * `MAVEN_PER_VERSION_LICENSES` is on, which buys a POM per version and is off by default.
 *
 * The metadata, the directory listing and the URLs live in `metadata.ts`, the POMs in `pom.ts`.
 */

export const mavenFetcher: PackageFetcher = {
    type: 'maven',

    async fetchPackage(key, ctx) {
        const base = artifactBase(key)
        const name = registryName(key)

        const response = await ctx.http.get(mavenMetadataUrl(key), {headers: {accept: 'application/xml'}})
        if (response.status === 404) return null
        if (!response.ok) {
            throw new HttpError(`${SOURCE} returned ${response.status} for ${name}`, response.url, response.status)
        }
        const metadata = parseMetadata(response.text)

        const dates = await fetchReleaseDates(base, name, ctx)
        const versions: FetchedVersion[] = metadata.versions.map(version => ({
            version,
            // A version listed in the metadata but absent from the listing keeps a null date
            // rather than borrowing one; a directory present in the listing but absent from the
            // metadata is not a published version and is ignored.
            releasedAt: dates.get(version) ?? null,
            licenses: [],
            prerelease: isPrerelease('maven', version),
            // Central is append-only: a released artifact is never withdrawn.
            yanked: false,
        }))

        const release = trustedRelease(versions, metadata.release)

        const pom = await fetchLibraryPom(base, key.name, versions, metadata.release, ctx)
        const licenses = pom?.licenses ?? []

        if (ctx.options.mavenPerVersionLicenses) await fillPerVersionLicenses(base, key.name, versions, licenses, ctx)
        else for (const version of versions) version.licenses = licenses

        return {
            description: pom?.description,
            homepageUrl: pom?.url,
            repoUrl: pom?.repoUrl,
            licenses,
            versions,
            // `<release>` is what the metadata plugin wrote: the newest non-snapshot *deploy*, by
            // deploy order rather than by version order. It is not a semantic "latest" — for guava
            // it names one of the two flavours that ship together — so it is reported as the
            // registry's designation and `computeLatest` in `latest.ts` still applies the policy.
            //
            // That policy believes the registry whenever the named version exists, so a `<release>`
            // Central never updated would win outright. `trustedRelease` is what withholds it; the
            // distrust lives here rather than in `latest.ts` because for npm and the rest the
            // registry's own designation *is* authoritative.
            registryLatest: release,
            sources: [SOURCE],
        }
    },
}

/** Where an artifact's `maven-metadata.xml` lives: the fetch reads it, and the server polls it. */
export function mavenMetadataUrl(key: Pick<ParsedPurl, 'namespace' | 'name'>): string {
    return `${artifactBase(key)}/maven-metadata.xml`
}
