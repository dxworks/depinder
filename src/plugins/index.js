"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPluginsFromNames = exports.plugins = void 0;
const fs_1 = __importDefault(require("fs"));
const plugin_loader_1 = require("../extension-points/plugin-loader");
function loadDynamicPlugins(pluginsFile) {
    try {
        const pluginsJson = JSON.parse(fs_1.default.readFileSync(pluginsFile).toString());
        return pluginsJson.map(it => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const imported = require(it.path);
            if (it.field)
                return imported[it.field];
            return imported;
        });
    }
    catch (e) {
        return [];
    }
}
function loadPlugins() {
    return [...plugin_loader_1.defaultPlugins, ...loadDynamicPlugins('plugins.json')]; // refactor to how dxworks cli does this when loading plugins
}
exports.plugins = loadPlugins();
function getPluginsFromNames(pluginNames) {
    if (!pluginNames || pluginNames.length === 0) {
        return exports.plugins;
    }
    return exports.plugins.filter(it => pluginNames.includes(it.name) || it.aliases?.some(alias => pluginNames.includes(alias)));
}
exports.getPluginsFromNames = getPluginsFromNames;
