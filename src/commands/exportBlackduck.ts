import {Command} from 'commander'
import fs from 'fs'
import path from 'path'
import {writeBlackDuckExport} from '../blackduck/export'
import {buildModel} from '../blackduck/model'
import {sbomPaths, SbomPath} from '../blackduck/paths'
import {sbomPluginsForPurlTypes} from '../plugins/sbom'
import {parsePurl} from '../plugins/sbom/cyclonedx'
import {walkDir} from '../utils/utils'
import {log} from '../utils/logging'
import {DEFAULT_MAX_AGE_HOURS} from '../vuln-sources/github/cache'
import {DEFAULT_TOKEN_FILE} from '../vuln-sources/github/tokens'
import {DEFAULT_VULN_SOURCE} from '../vuln-sources/selection'
import {AnalyseOptions, runAnalysis} from './analyse'

/**
 * `depinder export-blackduck <sbom-folder...>` — one reproducible command from a folder of
 * CycloneDX SBOMs to Black Duck-shaped CSVs.
 *
 * It is deliberately thin. The analysis is `analyse`'s, unchanged and uncopied: `runAnalysis` runs
 * the tree parse, the registry enrichment and the selected vulnerability sources and hands back
 * the enriched projects. This command adds exactly three things on top:
 *
 *   1. plugin selection — the ecosystems present in the SBOMs decide which `sbom-*` plugins run,
 *      so nobody has to know that a Gemfile.lock becomes `sbom-ruby`;
 *   2. the dependency paths, which only the raw SBOM graph holds (`paths.ts`);
 *   3. the five serialisers in `blackduck/export.ts`.
 *
 * The normal depinder CSVs are written too, into the same folder — the Black Duck files are an
 * additional view of one run, not a different run.
 */

export interface ExportBlackduckOptions extends AnalyseOptions {
    projectName?: string
}

export function createExportBlackduckCommand(): Command {
    return new Command()
        .name('export-blackduck')
        .description('Analyse a folder of CycloneDX SBOMs and write Black Duck-shaped CSV exports')
        .argument('<sbom-folders...>', 'Folders to walk for *.cdx.json SBOMs')
        .option('-r, --results <folder>', 'The results folder', 'results')
        .option('--refresh', 'Refresh the cache', false)
        .option('--project-name <name>',
            'The name to write in the Project path column and at the head of every dependency path')
        .option('--vuln-source <sources>',
            'A comma-separated list of trivy, grype, github, all',
            DEFAULT_VULN_SOURCE)
        .option('--github-token-file <file>',
            'Dotenv-style file holding GH_TOKEN_1, GH_TOKEN_2, ... for --vuln-source github',
            DEFAULT_TOKEN_FILE)
        .option('--github-max-age <hours>',
            'Re-download a cached ecosystem\'s GitHub advisories when they are older than this',
            String(DEFAULT_MAX_AGE_HOURS))
        .action(exportBlackduck)
}

export const exportBlackduckCommand = createExportBlackduckCommand()

/** Every `*.cdx.json` under the given folders. Same suffix the SBOM extractors match on. */
function sbomFilesIn(folders: string[]): string[] {
    return folders.flatMap(it => walkDir(it)).filter(it => it.endsWith('.cdx.json'))
}

/** The purl types the SBOMs actually contain — the input to plugin selection. */
export function purlTypesIn(sbomFiles: string[]): Set<string> {
    const types = new Set<string>()
    for (const file of sbomFiles) {
        try {
            const bom = JSON.parse(fs.readFileSync(file, 'utf8'))
            for (const component of bom.components ?? []) {
                const parsed = component.purl ? parsePurl(component.purl) : undefined
                if (parsed) types.add(parsed.type)
            }
        } catch (e: any) {
            log.warn(`Could not read ${path.basename(file)}: ${e?.message ?? e}`)
        }
    }
    return types
}

/**
 * The project name, which becomes the `Project path` column and the first segment of every
 * dependency path. Defaults to the SBOMs' shared basename — `ruby-mastodon` for both
 * `ruby-mastodon.cdx.json` and `ruby-mastodon.trivy.cdx.json` — falling back to the folder name
 * when a run spans several projects.
 */
export function defaultProjectName(sbomFiles: string[], folders: string[]): string {
    const names = new Set(sbomFiles.map(it =>
        path.basename(it).replace(/\.(trivy\.)?cdx\.json$/, '')))
    if (names.size === 1) return [...names][0]
    return path.basename(path.resolve(folders[0] ?? '.'))
}

export async function exportBlackduck(folders: string[], options: ExportBlackduckOptions): Promise<void> {
    const sbomFiles = sbomFilesIn(folders)
    if (sbomFiles.length === 0) {
        log.warn(`No *.cdx.json SBOMs found under ${folders.join(', ')}; nothing to export`)
        return
    }

    const purlTypes = purlTypesIn(sbomFiles)
    const plugins = sbomPluginsForPurlTypes(purlTypes)
    if (plugins.length === 0) {
        log.warn(`No sbom-* plugin covers the ecosystems in these SBOMs (${[...purlTypes].sort().join(', ')})`)
        return
    }
    log.info(`${sbomFiles.length} SBOM(s), ecosystems ${[...purlTypes].sort().join(', ')}`
        + ` -> plugins ${plugins.map(it => it.name).join(', ')}`)

    const analysed = await runAnalysis(folders, {...options, plugins: plugins.map(it => it.name)})

    const projectName = options.projectName ?? defaultProjectName(sbomFiles, folders)
    const exportedTypes = new Set(analysed.map(it => it.purlType))
    const paths: SbomPath[] = sbomFiles.flatMap(file =>
        sbomPaths(file, projectName, exportedTypes))

    const model = buildModel(projectName, analysed, paths)
    const resultFolder = path.resolve(process.cwd(), options.results || 'results')
    for (const {file, rows} of writeBlackDuckExport(model, resultFolder)) {
        log.info(`${String(rows).padStart(6)} row(s) -> ${file}`)
    }
    log.info(`Black Duck-shaped export written to ${resultFolder}`)
}
