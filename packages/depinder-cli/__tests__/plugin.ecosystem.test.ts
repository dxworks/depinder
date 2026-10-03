import {ecosystemOf, Plugin} from '../src/extension-points/plugin'
import {dotnetChecker, goChecker, javaChecker, npmChecker, phpChecker, pythonChecker, rubyChecker, rustChecker} from '../src/plugins/vulnerability-checkers'
import {VulnerabilityChecker} from '../src/extension-points/vulnerability-checker'
import {
    purlTypeOfPlugin,
    registryTypeOfPlugin,
    sbomDotnet,
    sbomGo,
    sbomJava,
    sbomNpm,
    sbomPhp,
    sbomPlugins,
    sbomPluginsForPurlTypes,
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
const table: [Plugin, string, string, VulnerabilityChecker, string[]][] = [
    [sbomJava, 'java', 'maven', javaChecker, ['java', 'maven', 'gradle']],
    [sbomNpm, 'npm', 'npm', npmChecker, ['npm', 'js', 'javascript', 'node', 'nodejs', 'yarn']],
    [sbomRuby, 'ruby', 'gem', rubyChecker, ['ruby', 'gem']],
    [sbomPython, 'python', 'pypi', pythonChecker, ['python', 'pip', 'pipenv', 'poetry']],
    [sbomPhp, 'php', 'composer', phpChecker, ['php', 'composer']],
    [sbomDotnet, 'dotnet', 'nuget', dotnetChecker, ['dotnet', '.net', 'c#', 'csharp', 'nuget']],
    [sbomGo, 'go', 'golang', goChecker, []],
    [sbomRust, 'rust', 'cargo', rustChecker, []],
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
    it.each(table)('enrich %p.name through the ecosystem checker, under its purl type', (plugin, _eco, purlType, checker) => {
        expect(plugin.checker).toBe(checker)
        expect(plugin.aliases?.[0]).toBe(`sbom-${purlType}`)
        expect(purlTypeOfPlugin(plugin)).toBe(purlType)
        expect(registryTypeOfPlugin(plugin)).toBe(purlType)
    })

    it.each(table)('select %p.name by each legacy plugin name', (plugin, _eco, _purl, _chk, aliases) => {
        expect(plugin.aliases?.slice(1)).toEqual(aliases)
        for (const alias of aliases) expect(getPluginsFromNames([alias])).toEqual([plugin])
    })

    it('are selected by their purl types', () => {
        expect(sbomPluginsForPurlTypes(['golang', 'cargo']).map(it => it.name)).toEqual(['sbom-go', 'sbom-rust'])
    })

    it('look a plugins.json plugin with no sbom alias up under its ecosystem', () => {
        expect(registryTypeOfPlugin({name: 'custom', ecosystem: 'npm'} as Plugin)).toBe('npm')
    })
})

describe('the vulnerability checkers', () => {
    it.each([
        ['MAVEN', javaChecker, 'org.slf4j:slf4j-api', 'pkg:maven/org.slf4j/slf4j-api@2.0.0'],
        ['NPM', npmChecker, '@babel/core', 'pkg:npm/%40babel/core@2.0.0'],
        ['RUBYGEMS', rubyChecker, 'rails', 'pkg:gem/rails@2.0.0'],
        ['PIP', pythonChecker, 'requests', 'pkg:pypi/requests@2.0.0'],
        ['COMPOSER', phpChecker, 'monolog/monolog', 'pkg:composer/monolog/monolog@2.0.0'],
        ['NUGET', dotnetChecker, 'Newtonsoft.Json', 'pkg:nuget/Newtonsoft.Json@2.0.0'],
        ['GO', goChecker, 'golang.org/x/net', 'pkg:golang/golang.org/x/net@2.0.0'],
        ['RUST', rustChecker, 'regex', 'pkg:cargo/regex@2.0.0'],
    ] as [string, VulnerabilityChecker, string, string][])('ask GitHub for %s advisories with a purl', (ecosystem, checker, name, purl) => {
        expect(checker.githubSecurityAdvisoryEcosystem).toBe(ecosystem)
        expect(checker.getPURL?.(name, '2.0.0')).toBe(purl)
    })
})
