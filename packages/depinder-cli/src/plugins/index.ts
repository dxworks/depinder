import {Plugin} from '../extension-points/plugin'
import {sbomPlugins} from './sbom'

/** The plugins named on the command line, by name or alias; all of them when none is named. */
export function getPluginsFromNames(pluginNames?: string[]): Plugin[] {
    if (!pluginNames || pluginNames.length === 0) {
        return sbomPlugins
    }
    return sbomPlugins.filter(it => pluginNames.includes(it.name) || it.aliases?.some(alias => pluginNames.includes(alias)))
}
