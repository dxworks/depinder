import {ecosystemOf, Plugin} from '../src/extension-points/plugin'
import {javaChecker, javaRegistrar} from '../src/plugins/java'
import {npmChecker, npmRegistrar} from '../src/plugins/javascript'
import {rubyChecker, rubyRegistrar} from '../src/plugins/ruby'
import {pythonChecker, pythonRegistrar} from '../src/plugins/python'
import {phpChecker, phpRegistrar} from '../src/plugins/php'
import {dotnetChecker, dotnetRegistrar} from '../src/plugins/dotnet'
import {goChecker, goRegistrar} from '../src/plugins/go/registrar'
import {cratesRegistrar, rustChecker} from '../src/plugins/rust/registrar'
import {Registrar} from '../src/extension-points/registrar'
import {VulnerabilityChecker} from '../src/extension-points/vulnerability-checker'
import {
    purlTypeOfPlugin,
    sbomDotnet,
    sbomGo,
    sbomJava,
    sbomNpm,
    sbomPhp,
    sbomPlugins,
    sbomPython,
    sbomRuby,
    sbomRust,
} from '../src/plugins/sbom'
import {getPluginsFromNames} from '../src/plugins'

/**
 * The cache key is `${ecosystem}:${name}`, and these namespaces are the ones every existing cache
 * was written under (by the manifest plugins SBOMs replaced). A change here invalidates every
 * user's cache for that ecosystem, which is what this table is here to catch.
 */
const table: [Plugin, string, string, Registrar, VulnerabilityChecker, string[]][] = [
    [sbomJava, 'java', 'maven', javaRegistrar, javaChecker, ['java', 'maven', 'gradle']],
    [sbomNpm, 'npm', 'npm', npmRegistrar, npmChecker, ['npm', 'js', 'javascript', 'node', 'nodejs', 'yarn']],
    [sbomRuby, 'ruby', 'gem', rubyRegistrar, rubyChecker, ['ruby', 'gem']],
    [sbomPython, 'python', 'pypi', pythonRegistrar, pythonChecker, ['python', 'pip', 'pipenv', 'poetry']],
    [sbomPhp, 'php', 'composer', phpRegistrar, phpChecker, ['php', 'composer']],
    [sbomDotnet, 'dotnet', 'nuget', dotnetRegistrar, dotnetChecker, ['dotnet', '.net', 'c#', 'csharp', 'nuget']],
    [sbomGo, 'go', 'golang', goRegistrar, goChecker, []],
    [sbomRust, 'rust', 'cargo', cratesRegistrar, rustChecker, []],
]

describe('ecosystemOf', () => {
    it('falls back to the plugin name', () => {
        expect(ecosystemOf({name: 'whatever'} as Plugin)).toBe('whatever')
    })

    it('covers every sbom plugin in the table', () => {
        expect(table.map(it => it[0])).toEqual(sbomPlugins)
    })

    it.each(table)('keeps %p.name on its cache namespace', (plugin, ecosystem) => {
        expect(ecosystemOf(plugin)).toBe(ecosystem)
    })
})

describe('the sbom plugins', () => {
    it.each(table)('enrich %p.name through the ecosystem registrar and checker', (plugin, _eco, purlType, registrar, checker) => {
        expect(plugin.registrar).toBe(registrar)
        expect(plugin.checker).toBe(checker)
        expect(plugin.aliases?.[0]).toBe(`sbom-${purlType}`)
        expect(purlTypeOfPlugin(plugin)).toBe(purlType)
    })

    it.each(table)('select %p.name by each legacy plugin name', (plugin, _eco, _purl, _reg, _chk, aliases) => {
        expect(plugin.aliases?.slice(1)).toEqual(aliases)
        for (const alias of aliases) expect(getPluginsFromNames([alias])).toEqual([plugin])
    })
})
