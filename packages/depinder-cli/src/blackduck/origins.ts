/**
 * Black Duck's origin vocabulary, and the two per-origin conventions that follow from it.
 *
 * Black Duck names the registry a component came from with its own words — `npmjs`, not `npm`;
 * `rubygems`, not `gem`; `packagist`, not `composer`; `crates`, not `cargo` — and then builds the
 * `Component Version Origin Id` differently per origin. Both were read off a real export
 * (`inputs/blackduck/ruby-mastodon/export/_dependencies.csv`, 9,037 rows) rather than guessed:
 *
 *     npmjs, rubygems, pypi, nuget, crates   name/version              `lodash/4.17.21`
 *     maven, packagist                       name:version              `commons-logging:commons-logging:1.2`
 *     github                                 owner/repo:version        `caddyserver/certmagic:v0.25.4`
 *     long_tail                              host/path#version         `go.googlesource.com/sys#v0.47.0`
 *
 * The colon form is not an accident of the ecosystem's own separator: packagist ids read
 * `monolog/monolog:3.9.0`, so the slash is part of the name and the colon is the version
 * separator. Getting this wrong is not cosmetic — the origin id is the join key the export diff
 * uses, so a wrong separator makes every row look like a row Black Duck does not have.
 *
 * Go has no registry, and Black Duck files each module under the host that serves it: a
 * `github.com/<owner>/<repo>` module goes under `github` as `owner/repo` (the `/v3` major suffix
 * and any subpath dropped), a `golang.org/x/<name>` module under `long_tail` as its
 * go.googlesource.com mirror. Every other host — `go.uber.org/zap`, `google.golang.org/grpc` — is
 * resolved through Black Duck's Knowledge Base to the GitHub repository behind the vanity import
 * (`uber-go/zap`, `grpc/grpc-go`), which an SBOM does not carry; those are written under `unknown`,
 * Black Duck's own fallback name, with the module path verbatim. A pseudo-version is written as
 * the commit it names: Black Duck holds the full 40-character hash, the SBOM only the 12 the
 * pseudo-version itself carries.
 */

export interface Origin {
    /** Black Duck's name for the registry. */
    name: string
    /** The purl type an SBOM component of this ecosystem carries. */
    purlType: string
    /** The separator between the component name and its version in `Component Version Origin Id`. */
    versionSeparator: '/' | ':' | '#'
    /** Where the project lives, when the origin id itself already names it. Only Go modules
     *  served from GitHub qualify: there the module path *is* the repository. */
    projectLink?: (name: string) => string
    /** For an ecosystem Black Duck files by host rather than by registry: which component names
     *  this origin takes. Absent means every component of the purl type. */
    claims?: (name: string) => boolean
    /** How the name is written in the origin id, when it is not the registry name verbatim. */
    idName?: (name: string) => string
    /** How the version is written in the origin id, when it is not the SBOM's verbatim. */
    idVersion?: (version: string) => string
}

const GO_GITHUB_MODULE = /^github\.com\/([^/]+\/[^/]+)/
const GO_X_MODULE = /^golang\.org\/x\/([^/]+)/

/**
 * `v0.0.0-20210328193216-ff5ff6dc229b`, `v1.1.8-0.20240110162603-74a5dd331745` and
 * `v2.0.0-pre.0.20230729083705-37449abec8cc` are the three pseudo-version shapes; the commit
 * prefix is the last 12 hex characters. Anything else is a tag and is kept as it is.
 */
const GO_PSEUDO_VERSION = /^v\d+\.\d+\.\d+(?:-(?:[^-]*\.)?0\.|-)\d{14}-([0-9a-f]{12})$/

export function goPseudoVersionCommit(version: string): string {
    return GO_PSEUDO_VERSION.exec(version)?.[1] ?? version
}

export const ORIGINS: readonly Origin[] = [
    {name: 'npmjs', purlType: 'npm', versionSeparator: '/'},
    {name: 'rubygems', purlType: 'gem', versionSeparator: '/'},
    {name: 'pypi', purlType: 'pypi', versionSeparator: '/'},
    {name: 'nuget', purlType: 'nuget', versionSeparator: '/'},
    {name: 'crates', purlType: 'cargo', versionSeparator: '/'},
    {name: 'maven', purlType: 'maven', versionSeparator: ':'},
    {name: 'packagist', purlType: 'composer', versionSeparator: ':'},
    {
        name: 'github', purlType: 'golang', versionSeparator: ':',
        projectLink: name => `https://github.com/${GO_GITHUB_MODULE.exec(name)?.[1] ?? name}`,
        claims: name => GO_GITHUB_MODULE.test(name),
        idName: name => GO_GITHUB_MODULE.exec(name)?.[1] ?? name,
        idVersion: goPseudoVersionCommit,
    },
    {
        name: 'long_tail', purlType: 'golang', versionSeparator: '#',
        claims: name => GO_X_MODULE.test(name),
        idName: name => `go.googlesource.com/${GO_X_MODULE.exec(name)?.[1] ?? name}`,
        idVersion: goPseudoVersionCommit,
    },
    {name: 'unknown', purlType: 'golang', versionSeparator: ':', idVersion: goPseudoVersionCommit},
]

/** Black Duck's own fallback for a component whose registry it cannot name. */
export const UNKNOWN_ORIGIN: Origin = {name: 'unknown', purlType: '', versionSeparator: '/'}

/** The origin Black Duck files a component under: by purl type, and for Go also by module host. */
export function originFor(purlType: string, name: string): Origin {
    const type = purlType.trim().toLowerCase()
    return ORIGINS.find(it => it.purlType === type && (!it.claims || it.claims(name))) ?? UNKNOWN_ORIGIN
}

/** `Component Version Origin Id`: the join key between our export and Black Duck's. */
export function originId(origin: Origin, name: string, version: string): string {
    return `${origin.idName?.(name) ?? name}${origin.versionSeparator}${origin.idVersion?.(version) ?? version}`
}

/**
 * One segment of a `Path`. Black Duck joins name and version the way the origin id does —
 * `org.eclipse.angus:angus-mail:2.0.5`, `laravel-lang/common:6.7.1`, `lodash/4.17.21` — with two
 * differences for Go: the segment keeps the full import path (`golang.org/x/sys:v0.47.0`, not the
 * go.googlesource.com id) and `long_tail`'s `#` is a colon there too.
 */
export function pathSegment(origin: Origin, name: string, version: string): string {
    return `${name}${origin.versionSeparator === '/' ? '/' : ':'}${version}`
}

/**
 * `Component Link`: where the *project* lives — not where this version is published.
 *
 * Black Duck fills the column from its Knowledge Base's project entity, which is why the value is
 * the same on every version of a component (0 of the 5,900 components in the reference export
 * carry two different links) and why it sits beside `Open Hub URL`, `Commit Activity` and
 * `Contributors in Past 12 Months` — all project facts, none of them version facts. The version is
 * deliberately not a parameter here.
 *
 * What the registrar read off the registry is the only input. Where the registry declares no
 * project URL, Black Duck writes nothing rather than falling back to the package's page — of 150
 * sampled npm components, every one of the 147 with a `homepage` had a Black Duck link and none of
 * them was empty — so a registry page is not a safe fallback: it is a different answer to a
 * different question, and it disagreed with Black Duck on 8,198 of 8,198 rows.
 */
export function componentLink(origin: Origin, name: string, homepage?: string): string {
    return canonicalProjectUrl(homepage) || origin.projectLink?.(name) || ''
}

/**
 * A project URL as a browser would open it.
 *
 * Registries hand back clone URLs as readily as web URLs — `git+https://<url>.git`, `git://<url>`,
 * `git@github.com:owner/repo.git` — and Black Duck holds the web form of the same page. Nothing is
 * invented here: a URL that is not http(s) after unwrapping (`mailto:`, a bare path, a private
 * host) is dropped, because a link that cannot be opened is worse than an empty cell.
 */
export function canonicalProjectUrl(url?: string): string {
    const raw = (url ?? '').trim()
    if (!raw) return ''
    const unwrapped = raw
        .replace(/^git\+/, '')
        .replace(/^git@([^:/]+):/, 'https://$1/')
        .replace(/^(?:git|ssh|git\+ssh):\/\//, 'https://')
        .replace(/^(https?:\/\/)[^/@]*@/, '$1')
        .replace(/\.git(?=$|[#?])/, '')
    return /^https?:\/\//i.test(unwrapped) ? unwrapped : ''
}
