import {DepinderDependency} from './extract'
import {LibraryInfo} from '../../core/library'

export interface CodeFinder {
    getDeclaredEntities?: (library: DepinderDependency) => Promise<string[]> // returns the list of entities that are declared in the library (e.g. classes, functions, packages, namespaces etc.)

    matchImportToLibrary?: (importStatement: ImportStatement) => LibraryInfo | null // tries to match an import statement to a library
}

export interface ImportStatement {
    file: string
    importedEntity: string
    modifiers: string[]
    language: string
    used?: boolean
    library?: string
    fullImport: string
}
