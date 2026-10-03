import {Extractor, Parser} from './extract'
import {Registrar} from './registrar'
import {VulnerabilityChecker} from './vulnerability-checker'
import {CodeFinder} from './code-impact'

export interface Plugin {
    name: string // the name of the technology (could be language name or package manager name)
    aliases?: string[] // potential aliases to use from CLI
    /**
     * Namespace under which this plugin's LibraryInfo is cached. Plugins that share a registrar
     * fetch identical data for identical library names and MUST share this value, or every library
     * is fetched once per plugin. Defaults to `name`, which keeps every pre-existing cache entry
     * valid.
     */
    ecosystem?: string
    extractor: Extractor // defines which files to search for
    parser?: Parser // defines how to parse the files specified by the extractor and returns a tree with all dependencies
    registrar: Registrar // gets information about libraries from package manager apis
    checker?: VulnerabilityChecker // checks for vulnerabilities for the found dependencies

    codeFinder?: CodeFinder // finds the references in code for a all dependencies of a project
}

export function ecosystemOf(plugin: Plugin): string {
    return plugin.ecosystem ?? plugin.name
}
