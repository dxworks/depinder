/**
 * Black Duck's origin vocabulary, and the two per-origin conventions that follow from it.
 *
 * Black Duck names the registry a component came from with its own words — `npmjs`, not `npm`;
 * `rubygems`, not `gem`; `packagist`, not `composer`; `crates`, not `cargo` — and then builds the
 * `Component Version Origin Id` differently per origin. Both were read off a real export
 * (`inputs/blackduck/ruby-mastodon/export/_dependencies.csv`, 9,037 rows) rather than guessed:
 *
 *     npmjs, rubygems, pypi, nuget, crates   name/version              `lodash/4.17.21`
 *     maven, packagist, github               name:version              `commons-logging:commons-logging:1.2`
 *
 * The colon form is not an accident of the ecosystem's own separator: packagist ids read
 * `monolog/monolog:3.9.0`, so the slash is part of the name and the colon is the version
 * separator. Getting this wrong is not cosmetic — the origin id is the join key the export diff
 * uses, so a wrong separator makes every row look like a row Black Duck does not have.
 */

export interface Origin {
    /** Black Duck's name for the registry. */
    name: string
    /** The purl type an SBOM component of this ecosystem carries. */
    purlType: string
    /** The separator between the component name and its version in `Component Version Origin Id`. */
    versionSeparator: '/' | ':'
    /** A registry page for the component, `{name}` and `{version}` substituted. Absent where the
     *  registry has no stable per-version URL we can derive from the coordinates alone. */
    componentLink?: string
}

export const ORIGINS: readonly Origin[] = [
    {name: 'npmjs', purlType: 'npm', versionSeparator: '/', componentLink: 'https://www.npmjs.com/package/{name}/v/{version}'},
    {name: 'rubygems', purlType: 'gem', versionSeparator: '/', componentLink: 'https://rubygems.org/gems/{name}/versions/{version}'},
    {name: 'pypi', purlType: 'pypi', versionSeparator: '/', componentLink: 'https://pypi.org/project/{name}/{version}/'},
    {name: 'nuget', purlType: 'nuget', versionSeparator: '/', componentLink: 'https://www.nuget.org/packages/{name}/{version}'},
    {name: 'crates', purlType: 'cargo', versionSeparator: '/', componentLink: 'https://crates.io/crates/{name}/{version}'},
    {name: 'maven', purlType: 'maven', versionSeparator: ':'},
    {name: 'packagist', purlType: 'composer', versionSeparator: ':', componentLink: 'https://packagist.org/packages/{name}#{version}'},
    {name: 'github', purlType: 'golang', versionSeparator: ':'},
]

const BY_PURL_TYPE = new Map(ORIGINS.map(it => [it.purlType, it]))

/** Black Duck's own fallback for a component whose registry it cannot name. */
export const UNKNOWN_ORIGIN: Origin = {name: 'unknown', purlType: '', versionSeparator: '/'}

export function originForPurlType(purlType: string): Origin {
    return BY_PURL_TYPE.get(purlType.trim().toLowerCase()) ?? UNKNOWN_ORIGIN
}

/** `Component Version Origin Id`: the join key between our export and Black Duck's. */
export function originId(origin: Origin, name: string, version: string): string {
    return `${name}${origin.versionSeparator}${version}`
}

/**
 * `Component Link`. The registrar's own homepage is preferred — it is what Black Duck fills the
 * column with — and the registry page is the fallback for the components no registrar reached.
 */
export function componentLink(origin: Origin, name: string, version: string, homepage?: string): string {
    if (homepage) return homepage
    if (!origin.componentLink) return ''
    return origin.componentLink
        .replace('{name}', encodeURIComponent(name).replaceAll('%2F', '/').replaceAll('%40', '@'))
        .replace('{version}', encodeURIComponent(version))
}
