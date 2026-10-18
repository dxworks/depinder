import fs from 'fs'
import path from 'path'
import {SbomDescription} from '../plugins/sbom/describe'
import {log} from '../utils/logging'
import {readRepoManifests, RepoFiles, RepoManifests} from './manifests'

/**
 * The scanned repositories' manifests, read from DepMiner's results instead of the repositories.
 *
 * DepMiner copies every manifest and lockfile it mines into one flat folder
 * (`results/depminer/package-3.json`, …) and its `index.json` maps each copy back to
 * `<repo>/<path>`. That is all `manifests.ts` needs, so the DepMiner results alone are enough.
 */

/** Where DepMiner writes its index, relative to its results folder. */
const INDEX_UNDER_RESULTS = path.join('depminer', 'index.json')

/** The manifests of the repository an SBOM was scanned from, if any are known. */
export type ManifestsOf = (sbom: SbomDescription) => RepoManifests | undefined

/** `<repo>` -> its files, from one DepMiner `index.json`. */
export function readDepMinerIndex(indexFile: string): Map<string, RepoFiles> {
    const entries: Record<string, string> = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
    const folder = path.dirname(indexFile)
    const repos = new Map<string, RepoFiles>()
    for (const [copy, original] of Object.entries(entries)) {
        const slash = original.indexOf('/')
        if (slash <= 0) continue
        const repo = original.slice(0, slash)
        if (!repos.has(repo)) repos.set(repo, new Map())
        repos.get(repo)?.set(original.slice(slash + 1), path.join(folder, copy))
    }
    return repos
}

/**
 * The nearest `depminer/index.json` at or above the SBOM's folder, looking no higher than the
 * folder that holds the input: `results/syft/x.cdx.json` finds `results/depminer/index.json`.
 */
export function findDepMinerIndex(sbomFile: string, inputFolder: string): string | undefined {
    const sbomFolder = path.dirname(path.resolve(sbomFile))
    const inputParent = path.dirname(path.resolve(inputFolder))
    const top = sbomFolder.startsWith(inputParent + path.sep) ? inputParent : path.dirname(sbomFolder)
    for (let dir = sbomFolder; ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, INDEX_UNDER_RESULTS)
        if (fs.existsSync(candidate)) return candidate
        if (dir === top || dir === path.dirname(dir)) return undefined
    }
}

/**
 * Looks up each SBOM's repository in a DepMiner index: the one `indexOption` names (the file, or
 * the folder holding it), none when it is `false`, else the one found beside the input.
 */
export function depMinerManifests(indexOption: string | false | undefined, inputFolder: string): ManifestsOf {
    if (indexOption === false) return () => undefined
    const explicit = indexOption ? indexFileOf(indexOption) : undefined
    const indexes = new Map<string, Map<string, RepoFiles> | undefined>()
    const manifests = new Map<string, RepoManifests | undefined>()
    let reportedMissing = false
    return sbom => {
        const indexFile = explicit ?? findDepMinerIndex(sbom.file, inputFolder)
        if (!indexFile) {
            if (!reportedMissing) log.info(`No DepMiner ${INDEX_UNDER_RESULTS} beside ${inputFolder}; `
                + 'Path keeps the plain directory prefix and the repository\'s own code')
            reportedMissing = true
            return undefined
        }
        if (!indexes.has(indexFile)) indexes.set(indexFile, loadIndex(indexFile))
        const repos = indexes.get(indexFile)
        const key = `${indexFile}\0${sbom.repo}`
        if (!manifests.has(key)) {
            const files = repos?.get(sbom.repo)
            if (repos && !files) log.warn(`${indexFile} lists no files of ${sbom.repo}; its paths get no project prefix`)
            manifests.set(key, files && readRepoManifests(files))
        }
        return manifests.get(key)
    }
}

function indexFileOf(option: string): string {
    const isFolder = fs.existsSync(option) && fs.statSync(option).isDirectory()
    return isFolder ? path.join(option, 'index.json') : option
}

function loadIndex(indexFile: string): Map<string, RepoFiles> | undefined {
    try {
        const repos = readDepMinerIndex(indexFile)
        log.info(`DepMiner index ${indexFile}: manifests of ${repos.size} repo(s)`)
        return repos
    } catch (e: any) {
        log.warn(`Could not read DepMiner index ${indexFile}: ${e?.message ?? e}; paths get no project prefix`)
        return undefined
    }
}
