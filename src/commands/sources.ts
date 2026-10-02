import path from 'path'
import {isSbomFile} from '../plugins/sbom'
import {describeSbom, isKnownProducer, KNOWN_PRODUCERS, SbomDescription} from '../plugins/sbom/describe'
import {log} from '../utils/logging'

/**
 * Sorting the walked files into the sources `analyse` writes one results subfolder for.
 *
 * A folder can hold anything — DepMiner writes Trivy SBOMs, Syft SBOMs and harvested lockfiles
 * side by side — so the file's own content decides, never the folder it was found in or the
 * name it was saved under: a CycloneDX file crediting Trivy is Trivy's, one crediting Syft is
 * Syft's, and everything else is ignored. CycloneDX SBOMs are depinder's only input.
 */

/** The SBOMs one producer wrote, in walk order. */
export interface SbomSource {
    /** `trivy` or `syft` — also the results subfolder. */
    name: string
    sboms: SbomDescription[]
}

export interface InputSources {
    /** Ordered as `KNOWN_PRODUCERS` lists them: trivy, then syft. */
    sbom: SbomSource[]
}

export function classifyInputs(files: string[]): InputSources {
    let ignored = 0
    const byProducer = new Map<string, SbomDescription[]>(KNOWN_PRODUCERS.map(it => [it, []]))
    for (const file of files) {
        if (!isSbomFile(file)) {
            ignored++
            continue
        }
        let sbom: SbomDescription
        try {
            sbom = describeSbom(file)
        } catch (e: any) {
            log.warn(`Skipping ${path.basename(file)}: ${e?.message ?? e}`)
            continue
        }
        if (!isKnownProducer(sbom.producer)) {
            log.warn(`Skipping ${path.basename(file)}: written by ${sbom.producer}, and only`
                + ` ${KNOWN_PRODUCERS.join(' and ')} SBOMs are analysed`)
            continue
        }
        if (!sbom.repoFromMetadata) {
            log.info(`${path.basename(file)} names no project in its metadata; using ${sbom.repo} from the file name`)
        }
        byProducer.get(sbom.producer)?.push(sbom)
    }
    const sbom = KNOWN_PRODUCERS
        .map(name => ({name, sboms: byProducer.get(name) ?? []}))
        .filter(it => it.sboms.length > 0)
    for (const source of sbom) warnDuplicateRepos(source)
    if (ignored > 0) log.info(`Ignored ${ignored} file(s) that are not CycloneDX SBOMs`)
    return {sbom}
}

/**
 * The same repository twice from one producer is almost always the same scan saved twice, or two
 * input folders overlapping. Both are analysed — a re-scan after a fix is legitimate — but the
 * user is told, because the Black Duck files would carry the repository twice.
 */
function warnDuplicateRepos(source: SbomSource): void {
    const byRepo = new Map<string, SbomDescription[]>()
    for (const sbom of source.sboms) byRepo.set(sbom.repo, [...(byRepo.get(sbom.repo) ?? []), sbom])
    for (const [repo, sboms] of byRepo) {
        if (sboms.length < 2) continue
        log.warn(`${source.name} has ${sboms.length} SBOMs for repo ${repo}: `
            + `${sboms.map(it => path.basename(it.file)).join(', ')} — all of them are analysed`)
    }
}

/**
 * The input folder a source's SBOMs came from, when they all came from one — the fallback for
 * the project name. With SBOMs spread over several input folders the first one given wins.
 */
export function inputFolderOf(source: SbomSource, folders: string[]): string {
    const resolved = folders.map(it => path.resolve(it))
    const containing = new Set(source.sboms.map(sbom =>
        resolved.find(folder => sbom.file === folder || sbom.file.startsWith(folder + path.sep))))
    if (containing.size === 1) {
        const [folder] = containing
        if (folder) return folder
    }
    return folders[0] ?? '.'
}
