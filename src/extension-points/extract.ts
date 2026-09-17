import {SemVer} from 'semver'
import {LibraryInfo} from './registrar'
import {Vulnerability} from './vulnerability-checker'

export interface Extractor {
    files: string[]
    filter?: (file: string) => boolean // function to filter out irrelevant files
    // lockCommand?: LockCommand
    createContexts: (files: string[]) => DependencyFileContext[]
}

export interface Parser {
    parseDependencyTree: ParseDependencyTree
}
export type ParseDependencyTree = (context: DependencyFileContext) => DepinderProject | Promise<DepinderProject>


// export type LockCommand = (context: Context) => string
//
// export interface Context {
//     cwd: string
// }

export interface DependencyFileContext {
    root: string // the root folder of the project
    manifestFile?: string // the file where direct dependencies are specified + other project information
    lockFile: string // the file to parse to get the dependency tree
    type? :string // the type of the project, especially useful in Java where there are multiple types of projects  (e.g. maven, gradle, etc.)
}

export interface DepinderProject {
    name: string // read from DependencyFileContext.manifestFile
    version: string // read from DependencyFileContext.manifestFile
    path: string // the same as DependencyFileContext.root
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
    semver: SemVer | null
    type?: string  // dev dependency, test dependency, provided, etc.
    requestedBy: string[] // the list of ids for dependencies that requested this dependency
    /**
     * The package URL for this exact name and version, e.g. `pkg:maven/com.google.guava/guava@32.1.2-jre`.
     *
     * Filled by `analyse` from the plugin's `checker.getPURL`, not by the parsers: it is the key
     * the bulk resolver speaks, and the one identifier that means the same thing across plugins,
     * which is what lets one dependency shared by two plugins be asked about once.
     */
    purl?: string
    libraryInfo?: LibraryInfo
    vulnerabilities?: Vulnerability[]
}
