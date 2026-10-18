import {LibraryInfo} from './library-info'
import {Vulnerability} from './vulnerability-checker'

export interface DepinderProject {
    name: string
    version: string
    path: string // the project's location, as its SBOM records it
    dependencies: {
        [dependencyId: string]: DepinderDependency
    }

    /**
     * Set by a parser that has already resolved vulnerabilities for the EXACT installed version of
     * every dependency in this project — e.g. a local Trivy/Grype scan of the SBOM the project was
     * parsed from.
     *
     * When true, each dependency's `vulnerabilities` array is final: `analyse` must neither
     * overwrite it nor apply the semver-range filter, which exists only for the library-level
     * advisory data on `LibraryInfo.vulnerabilities`. A dependency with no findings carries `[]`,
     * not `undefined` — absence is a result, not a gap.
     *
     * When false or absent, no dependency carries vulnerabilities and `analyse` fills them from
     * `LibraryInfo.vulnerabilities`, range-filtered to each dependency's version.
     */
    exactVersionVulnerabilities?: boolean
}

export interface DepinderDependency {
    id: string // name@exact_version
    name: string
    version: string
    requestedBy: string[] // the list of ids for dependencies that requested this dependency
    /**
     * The package URL for this exact name and version, e.g. `pkg:maven/com.google.guava/guava@32.1.2-jre`.
     *
     * Filled by the CycloneDX parser from the component's own purl, normalised so Syft and Trivy
     * spell one package identically (`normalizePurl`); `assignPurl` spells one from the name for
     * a dependency that arrives without one. It is the key the bulk resolver
     * speaks, and the one identifier that means the same thing across plugins, which is what lets
     * one dependency shared by two plugins be asked about once.
     */
    purl?: string
    libraryInfo?: LibraryInfo
    vulnerabilities?: Vulnerability[]
}
