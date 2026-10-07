import {Plugin} from '../extension-points/plugin'
import fs from 'fs'
import {defaultPlugins} from '../extension-points/plugin-loader'

function loadDynamicPlugins(pluginsFile: string): Plugin[] {
    try {
        const pluginsJson = JSON.parse(fs.readFileSync(pluginsFile).toString()) as { path: string, field?: string }[]

        return pluginsJson.map(it => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const imported = require(it.path)
            if (it.field)
                return imported[it.field]
            return imported
        })
    } catch (e: any) {
        return []
    }
}

function loadPlugins() {
    return [...defaultPlugins, ...loadDynamicPlugins('plugins.json')] // refactor to how dxworks cli does this when loading plugins
}

export const plugins: Plugin[] = loadPlugins()

export function getPluginsFromNames(pluginNames?: string[]): Plugin[] {
    if(!pluginNames || pluginNames.length === 0) {
        return plugins
    }
    return plugins.filter(it => pluginNames.includes(it.name) || it.aliases?.some(alias => pluginNames.includes(alias)))
}