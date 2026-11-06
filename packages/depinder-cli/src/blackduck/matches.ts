import type {PurlCoordinates} from '../plugins/sbom/purl'
import type {SbomPath} from './paths'

export type SbomMatch = Pick<SbomPath, 'name' | 'version' | 'purlType'> & {
    matchType: SbomPath['matchType'] | 'Direct Dependency,Transitive Dependency'
}

/** Retain all parent evidence after own-code contraction, beyond the shortest source path. */
export function componentMatches(
    paths: SbomPath[], parents: Iterable<[string, string[]]>,
    coordinatesOf: (ref: string) => PurlCoordinates | undefined,
): SbomMatch[] {
    const transitive = new Set<string>()
    for (const [parent, children] of parents) {
        const source = coordinatesOf(parent)
        for (const child of children) {
            const target = coordinatesOf(child)
            if (target && (source?.name !== target.name || source.version !== target.version)) {
                transitive.add(`${target.name}@${target.version}`)
            }
        }
    }
    return paths.map(({name, version, purlType, matchType}) => ({
        name, version, purlType,
        matchType: matchType === 'Direct Dependency' && transitive.has(`${name}@${version}`)
            ? 'Direct Dependency,Transitive Dependency' : matchType,
    }))
}
