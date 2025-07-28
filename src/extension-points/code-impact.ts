import {DepinderDependency} from './extract'

export interface CodeFinder {
    matchImportToLibrary: (importStatement: ImportStatement, depinderDependencies: Record<string, DepinderDependency>) => DepinderDependency | null // tries to match an import statement to a library
    getDependencyKey: (depinderDependency: DepinderDependency) => string // returns the key that is used to identify a dependency
}

export interface ImportStatement {
    file: string
    projectPath: string
    importedEntity: string
    modifiers: string[]
    language: string
    // used?: boolean -> not implemented yet in the script for getting the imports
    library: string
    fullImport: string
}
