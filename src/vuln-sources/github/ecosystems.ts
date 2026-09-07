/**
 * The mapping between GitHub's advisory ecosystem names, Package URL types, and the version
 * comparator family each ecosystem needs.
 *
 * GitHub's REST `GET /advisories` takes `ecosystem=<name>` from a closed vocabulary, and the
 * `vulnerabilities[].package.ecosystem` it echoes back uses the same spelling. SBOMs, meanwhile,
 * speak purl types. The two vocabularies disagree on four names (`rubygems`/`gem`, `pip`/`pypi`,
 * `go`/`golang`, `rust`/`cargo`), which is exactly the kind of difference that silently produces
 * zero findings, so it is stated once here and nowhere else.
 */

/** The version-ordering rule an ecosystem obeys. See `versions.ts` for the implementations. */
export type ComparatorFamily = 'semver' | 'pep440' | 'gem' | 'generic'

export interface GithubEcosystem {
    /** The value GitHub accepts for `?ecosystem=` and echoes in `package.ecosystem`. */
    name: string
    /** The purl type an SBOM component of this ecosystem carries. */
    purlType: string
    comparator: ComparatorFamily
}

/**
 * Every ecosystem the advisories API offers, as of the 2022-11-28 REST API version. `other` is
 * excluded deliberately: its advisories carry no machine-usable package coordinates, so nothing
 * in an SBOM could ever match them.
 */
export const GITHUB_ECOSYSTEMS: readonly GithubEcosystem[] = [
    {name: 'npm', purlType: 'npm', comparator: 'semver'},
    {name: 'rubygems', purlType: 'gem', comparator: 'gem'},
    {name: 'pip', purlType: 'pypi', comparator: 'pep440'},
    {name: 'maven', purlType: 'maven', comparator: 'generic'},
    {name: 'nuget', purlType: 'nuget', comparator: 'generic'},
    {name: 'composer', purlType: 'composer', comparator: 'generic'},
    {name: 'go', purlType: 'golang', comparator: 'generic'},
    {name: 'rust', purlType: 'cargo', comparator: 'generic'},
    {name: 'erlang', purlType: 'hex', comparator: 'generic'},
    {name: 'actions', purlType: 'github', comparator: 'generic'},
    {name: 'pub', purlType: 'pub', comparator: 'generic'},
    {name: 'swift', purlType: 'swift', comparator: 'generic'},
]

const BY_NAME = new Map(GITHUB_ECOSYSTEMS.map(it => [it.name, it]))
const BY_PURL_TYPE = new Map(GITHUB_ECOSYSTEMS.map(it => [it.purlType, it]))

export function ecosystemByName(name: string): GithubEcosystem | undefined {
    return BY_NAME.get(name.trim().toLowerCase())
}

export function ecosystemForPurlType(purlType: string): GithubEcosystem | undefined {
    return BY_PURL_TYPE.get(purlType.trim().toLowerCase())
}

/**
 * Accepts either vocabulary, so `--ecosystems npm,gem` and `--ecosystems npm,rubygems` mean the
 * same thing. Unknown names are returned so the caller can report them rather than drop them.
 */
export function resolveEcosystems(names: string[]): {resolved: GithubEcosystem[], unknown: string[]} {
    const resolved: GithubEcosystem[] = []
    const unknown: string[] = []
    for (const raw of names) {
        const name = raw.trim().toLowerCase()
        if (!name) continue
        const found = ecosystemByName(name) ?? ecosystemForPurlType(name)
        if (!found) unknown.push(raw.trim())
        else if (!resolved.includes(found)) resolved.push(found)
    }
    return {resolved, unknown}
}

/**
 * Name normalisation, per ecosystem. Applied to BOTH the advisory's package name and the SBOM
 * component's name, so it only has to be self-consistent — it is a lookup key, never displayed.
 *
 *  - pip: PEP 503, the only rule that is genuinely lossy (`Foo_Bar` and `foo.bar` are one project).
 *  - maven: `group:artifact`. Advisories already use the colon form; purls decode to it in
 *    `parsePurl`, but a raw `group/artifact` is accepted here too.
 *  - everything else: case folding. npm, composer and go names are lowercase by registry rule;
 *    nuget is explicitly case-insensitive; gem and cargo names may carry capitals (`Ascii85`), and
 *    folding both sides of the comparison is safe because no two gems differ only by case.
 */
export function normalizeName(ecosystem: string, name: string): string {
    const trimmed = name.trim()
    switch (ecosystem) {
        case 'pip':
            return trimmed.toLowerCase().replace(/[-_.]+/g, '-')
        case 'maven':
            return trimmed.includes(':') ? trimmed : trimmed.replace('/', ':')
        default:
            return trimmed.toLowerCase()
    }
}
