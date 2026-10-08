import {DepinderDependency} from '../../extension-points/extract'
import {Plugin} from '../../extension-points/plugin'
import {purlTypeOfPlugin} from './index'
import {purlFromRegistryName} from './purl'

/**
 * The purl a dependency is known by: the SBOM's own (`normalizePurl`), else one spelled from its
 * plugin's purl type, name and version. The fallback is stored on the dependency, so whichever
 * phase asks first computes it and every later one reads the same purl. A dependency with no
 * version, or of a plugin without a purl type, keeps none and takes the registrar path.
 */
export function assignPurl(plugin: Plugin, dep: DepinderDependency): string | undefined {
    if (dep.purl) return dep.purl
    const version = dep.version?.trim()
    const purlType = purlTypeOfPlugin(plugin)
    if (!version || !purlType) return undefined
    dep.purl = purlFromRegistryName(purlType, dep.name, version)
    return dep.purl
}
