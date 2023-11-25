import {Extractor, Parser} from './extract'
import {Registrar} from './registrar'
import {CodeFinder} from './code-impact'
import {VulnerabilityChecker} from '../../core/vulnerability-checker'

export interface Plugin {
    name: string // the name of the technology (could be language name or package manager name)
    aliases?: string[] // potential aliases to use from CLI
    extractor: Extractor // defines which files to search for
    parser?: Parser // defines how to parse the files specified by the extractor and returns a tree with all dependencies
    registrar: Registrar // gets information about libraries from package manager apis
    checker?: VulnerabilityChecker // checks for vulnerabilities for the found dependencies

    codeFinder?: CodeFinder // finds the references in code for a all dependencies of a project
}