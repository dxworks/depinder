import path from 'path'
import {SbomDescription} from '../plugins/sbom/describe'
import {log} from '../utils/logging'
import {timePhaseSync} from '../utils/profile'
import {WrittenFile, writeBlackDuckExport} from './export'
import {AnalysedEcosystem, buildModel} from './model'
import {SbomEdge, SbomPath, sbomTree} from './paths'

/**
 * The Black Duck-shaped files for one SBOM source, on top of what `analyse` already wrote.
 *
 * The analysis is `analyse`'s own, uncopied: this step adds the dependency paths, which only the
 * raw SBOM graph holds (`paths.ts`), builds the one model every file is a view of (`model.ts`)
 * and runs the serialisers (`export.ts`). Nothing here knows how the projects were enriched.
 */

export interface BlackDuckRunOptions {
    /** `Project path` and the head of every dependency path. Defaults to `defaultProjectName`. */
    projectName?: string
    /** The scanned repositories, one per SBOM repo name; their manifests give `Path` its prefix. */
    target?: string
}

/**
 * The export's root label, which becomes the `Project path` column. The SBOMs' shared repo name
 * when there is one; the input folder's name when the run spans several repos.
 */
export function defaultProjectName(sboms: SbomDescription[], inputFolder: string): string {
    const names = new Set(sboms.map(it => it.repo))
    if (names.size === 1) return [...names][0]
    return path.basename(path.resolve(inputFolder))
}

export function writeBlackDuckForSource(
    sboms: SbomDescription[],
    analysed: AnalysedEcosystem[],
    resultFolder: string,
    inputFolder: string,
    options: BlackDuckRunOptions,
): WrittenFile[] {
    const projectName = options.projectName ?? defaultProjectName(sboms, inputFolder)
    const exportedTypes = new Set(analysed.map(it => it.purlType))
    // One source can hold several repos' SBOMs, and the repo a path belongs to is the SBOM's own
    // repo, not the run's label — so each file contributes its paths under its own repo. An
    // explicit --project-name still overrides, for a run that really is a single project.
    // The repository a SBOM was scanned from sits under --target by that same repo name.
    const repoDirOf = (sbom: SbomDescription) => options.target ? path.join(options.target, sbom.repo) : undefined
    const trees = timePhaseSync('blackduck:paths', () => sboms.map(sbom =>
        sbomTree(sbom.file, options.projectName ?? sbom.repo, exportedTypes, {repoDir: repoDirOf(sbom)})))
    const paths: SbomPath[] = trees.flatMap(it => it.paths)
    const edges: SbomEdge[] = trees.flatMap(it => it.edges)

    const model = timePhaseSync('blackduck:model', () => buildModel(projectName, analysed, paths, edges))
    const written = timePhaseSync('blackduck:csv', () => writeBlackDuckExport(model, resultFolder))
    for (const {file, rows} of written) {
        log.info(`${String(rows).padStart(6)} row(s) -> ${file}`)
    }
    log.info(`Black Duck-shaped export written to ${resultFolder}`)
    return written
}
