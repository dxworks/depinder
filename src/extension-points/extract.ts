import {SemVer} from 'semver'
import {Vulnerability} from '../../core/vulnerability-checker'
import {LibraryInfo} from '../../core/library'

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
    },
    manifestFile?: string,
    lockFile?: string,
}

export interface DepinderDependency {
    id: string // name@exact_version
    name: string
    version: string
    semver: SemVer | null
    type?: string  // dev dependency, test dependency, provided, etc.
    requestedBy: string[] // the list of ids for dependencies that requested this dependency
    libraryInfo?: LibraryInfo
    vulnerabilities?: Vulnerability[]
}
