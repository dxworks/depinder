import {LibraryInfo} from '../extension-points/registrar'
import {VersionComparator} from '../vuln-sources/github/versions'

type RegistryVersion = LibraryInfo['versions'][number]

/**
 * `Newer Versions`, counted the two ways the question can be asked.
 *
 * Black Duck answers "how many versions were released AFTER mine": its Knowledge Base holds a
 * release date per version and never orders version numbers. Ours answered "how many versions are
 * numbered ABOVE mine". The two agree on a package that only ever moves forward and part ways on
 * every one that maintains two lines at once: `@babel/helper-optimise-call-expression` 7.29.7 has
 * 30 versions numbered above it (the whole 8.0.0 alpha and beta series, begun three years earlier)
 * and one released after it (8.0.0 itself). Black Duck writes 1. On the run this was measured on,
 * counting by date matched Black Duck's cell for 82% of the npm components against 68% by number.
 *
 * Both are worth having, so both are written: `byDate` under Black Duck's own column name, where
 * it can be compared cell for cell, and `bySemver` beside it, which is the count a person wanting
 * to upgrade actually asks for.
 *
 * Empty, not `0`, when the registrar had no answer -- "we do not know" and "you are current" are
 * different statements, and Black Duck's column distinguishes them too. `byDate` is also empty when
 * the resolved version is not in the registry's list or carries no release date, because a count
 * against an unknown date would be a guess.
 */
export function newerVersionCounts(
    versions: RegistryVersion[], currentVersion: string, compare: VersionComparator,
): {byDate: string, bySemver: string} {
    if (versions.length === 0) return {byDate: '', bySemver: ''}
    const current = versions.find(it => it.version === currentVersion.trim())
    const released = current?.timestamp
    return {
        byDate: released
            ? String(versions.filter(it => !isBranchAlias(it.version) && (it.timestamp ?? 0) > released).length)
            : '',
        bySemver: String(versions.filter(it => compare(it.version, currentVersion) > 0).length),
    }
}

/**
 * Composer lists branches next to releases -- `dev-master`, `2.x-dev` -- and every one of them
 * carries the date of its last commit, so by date they would outrank every release. Black Duck
 * does not count them (excluding them took the packagist match from 20 to 186 of 239), and they
 * are not versions anyone can be behind on.
 */
function isBranchAlias(version: string): boolean {
    return version.startsWith('dev-') || version.endsWith('-dev')
}
