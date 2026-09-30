import fs from 'fs'
import path from 'path'
import {CycloneDxBom, metadataProjectName, parsePurl, repoNameFromFile} from './cyclonedx'

/**
 * What one CycloneDX file says about itself, read once per process.
 *
 * `analyse` decides from the file's content — never from its name or the folder it sits in —
 * which producer wrote it and which repository it describes. The producer chooses the results
 * subfolder (`trivy/`, `syft/`), the repository names the dependency paths, and the purl types
 * select the `sbom-*` plugins. All three come out of a single read.
 */
export interface SbomDescription {
    /** Absolute path. */
    file: string
    /** `trivy`, `syft`, another tool's name lowercased, or `unknown` when the SBOM lists no tool. */
    producer: string
    toolVersion?: string
    /** The repository the SBOM describes: `metadata.component.name`, else the file's basename. */
    repo: string
    /** False when the name had to come from the file name. */
    repoFromMetadata: boolean
    /** The purl types the components carry — the input to plugin selection. */
    purlTypes: Set<string>
    specVersion?: string
}

/** The producers whose SBOMs `analyse` processes; anything else is warned about and skipped. */
export const KNOWN_PRODUCERS = ['trivy', 'syft'] as const
export type KnownProducer = typeof KNOWN_PRODUCERS[number]

export function isKnownProducer(producer: string): producer is KnownProducer {
    return (KNOWN_PRODUCERS as readonly string[]).includes(producer)
}

interface Tool {
    name?: string
    version?: string
}

/**
 * The first tool the SBOM credits. CycloneDX 1.5 nests them under `metadata.tools.components`
 * (and `.services`); 1.4 and older make `metadata.tools` the array itself. Both Trivy and Syft
 * write the 1.5 shape today, but an older SBOM is still an SBOM.
 */
function toolsOf(bom: CycloneDxBom): Tool[] {
    const tools = bom.metadata?.tools as unknown
    if (Array.isArray(tools)) return tools.filter(isTool)
    if (tools && typeof tools === 'object') {
        const nested = tools as {components?: unknown, services?: unknown}
        return [...(Array.isArray(nested.components) ? nested.components : []),
            ...(Array.isArray(nested.services) ? nested.services : [])].filter(isTool)
    }
    return []
}

function isTool(it: unknown): it is Tool {
    return !!it && typeof it === 'object' && typeof (it as Tool).name === 'string'
}

/** Producer name and version, normalised: `trivy`, `syft`, or another tool's name lowercased. */
export function producerOf(bom: CycloneDxBom): {producer: string, toolVersion?: string} {
    const tools = toolsOf(bom)
    for (const known of KNOWN_PRODUCERS) {
        const tool = tools.find(it => new RegExp(known, 'i').test(it.name ?? ''))
        if (tool) return {producer: known, toolVersion: tool.version}
    }
    const first = tools[0]
    if (!first?.name) return {producer: 'unknown'}
    return {
        producer: first.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-'),
        toolVersion: first.version,
    }
}

/** The purl types the components carry; a component without a parseable purl contributes none. */
export function purlTypesOf(bom: CycloneDxBom): Set<string> {
    const types = new Set<string>()
    for (const component of bom.components ?? []) {
        const parsed = component.purl ? parsePurl(component.purl) : undefined
        if (parsed) types.add(parsed.type)
    }
    return types
}

const descriptions = new Map<string, SbomDescription>()

/**
 * Reads and describes one SBOM. Throws when the file is not readable JSON, or is JSON that is
 * not a CycloneDX BOM; the caller decides whether that is a warning or an error. Memoised by
 * resolved path: plugin selection, path building and provenance all ask about the same files.
 */
export function describeSbom(sbomFile: string): SbomDescription {
    const file = path.resolve(sbomFile)
    const hit = descriptions.get(file)
    if (hit) return hit

    const bom = JSON.parse(fs.readFileSync(file, 'utf8')) as CycloneDxBom
    if (!bom || typeof bom !== 'object' || (bom.bomFormat !== undefined && bom.bomFormat !== 'CycloneDX')) {
        throw new Error(`not a CycloneDX BOM (bomFormat ${JSON.stringify(bom?.bomFormat)})`)
    }
    if (bom.bomFormat === undefined && !Array.isArray(bom.components)) {
        throw new Error('not a CycloneDX BOM (no bomFormat and no components)')
    }
    const fromMetadata = metadataProjectName(bom)
    const description: SbomDescription = {
        file,
        ...producerOf(bom),
        repo: fromMetadata ?? repoNameFromFile(file),
        repoFromMetadata: fromMetadata !== undefined,
        purlTypes: purlTypesOf(bom),
        specVersion: bom.specVersion,
    }
    descriptions.set(file, description)
    return description
}

/** Exposed for tests, which write a fresh file under the same name. */
export function clearSbomDescriptions(): void {
    descriptions.clear()
}
