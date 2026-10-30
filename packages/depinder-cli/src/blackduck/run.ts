import path from 'path'
import {SbomDescription} from '../plugins/sbom/describe'
import {log} from '../utils/logging'
import {depMinerManifests} from './depminer-index'
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

/**
 * The export's project label. The SBOMs' shared repo name
 * when there is one; the input folder's name when the run spans several repos.
 */
export function defaultProjectName(sboms: SbomDescription[], inputFolder: string): string {
    const names = new Set(sboms.map(it => it.repo))
    if (names.size === 1) return [...names][0]
    return path.basename(path.resolve(inputFolder))
}

export interface BlackDuckRunOptions {
    /** DepMiner's index file or folder; false disables lookup, undefined discovers it beside input. */
    depminerIndex?: string | false
}

export function writeBlackDuckForSource(
    sboms: SbomDescription[],
    analysed: AnalysedEcosystem[],
    resultFolder: string,
    inputFolder: string,
    options: BlackDuckRunOptions = {},
): WrittenFile[] {
    const projectName = defaultProjectName(sboms, inputFolder)
    const exportedTypes = new Set(analysed.map(it => it.purlType))
    // Repository identity comes from each SBOM; the report label must not replace it.
    const manifestsOf = depMinerManifests(options.depminerIndex, inputFolder)
    const trees = timePhaseSync('blackduck:paths', () => sboms
        .filter(sbom => [...sbom.purlTypes].some(type => exportedTypes.has(type)))
        .map(sbom => sbomTree(sbom.file, sbom.repo, exportedTypes, {manifests: manifestsOf(sbom)})))
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
