import {ecosystemOf, Plugin} from '../src/extension-points/plugin'
import {java} from '../src/plugins/java'
import {javascript} from '../src/plugins/javascript'
import {ruby} from '../src/plugins/ruby'
import {python} from '../src/plugins/python'
import {php} from '../src/plugins/php'
import {dotnet} from '../src/plugins/dotnet'
import {sbomDotnet, sbomJava, sbomNpm, sbomPhp, sbomPython, sbomRuby} from '../src/plugins/sbom'

const pairs: [string, Plugin, Plugin][] = [
    ['java', java, sbomJava],
    ['javascript', javascript, sbomNpm],
    ['ruby', ruby, sbomRuby],
    ['python', python, sbomPython],
    ['php', php, sbomPhp],
    ['dotnet', dotnet, sbomDotnet],
]

describe('ecosystemOf', () => {
    it('falls back to the plugin name, keeping every pre-existing cache entry valid', () => {
        expect(ecosystemOf({name: 'whatever'} as Plugin)).toBe('whatever')
    })

    it.each(pairs)('gives the sbom route the same cache namespace as %s', (_name, native, sbom) => {
        expect(ecosystemOf(sbom)).toBe(native.name)
        expect(ecosystemOf(native)).toBe(native.name)
    })

    it.each(pairs)('leaves the native plugin %s untouched', (_name, native) => {
        expect(native.ecosystem).toBeUndefined()
    })
})

describe('the invariant that makes a shared cache namespace sound', () => {
    /**
     * The two routes share cache entries, so whichever runs first supplies the LibraryInfo for
     * both. That is only correct while they fetch and enrich identically — same registrar, and same
     * advisory checker so both write the same GHSA data onto the entry. If someone later gives the
     * sbom route its own checker (e.g. "we get vulnerabilities from Trivy, skip GHSA"), a cache
     * entry written by the sbom route would silently strip advisories from the native route's
     * output. This test is what fails first.
     */
    it.each(pairs)('shares the registrar and checker of %s by reference', (_name, native, sbom) => {
        expect(sbom.registrar).toBe(native.registrar)
        expect(sbom.checker).toBe(native.checker)
    })
})
