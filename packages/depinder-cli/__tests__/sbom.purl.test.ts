import {normalizePurl} from '../src/plugins/sbom/purl'

/**
 * `normalizePurl` is what makes a Syft and a Trivy SBOM of the same repo name each package with the
 * same purl. The inputs below are the spellings the two tools actually write.
 */
describe('normalizePurl', () => {
    it('strips qualifiers and subpath, which Syft writes and Trivy does not', () => {
        expect(normalizePurl('pkg:maven/org.slf4j/slf4j-api@1.7.35?package-id=5c1b&type=jar#sub/dir'))
            .toBe('pkg:maven/org.slf4j/slf4j-api@1.7.35')
        expect(normalizePurl('pkg:npm/side-channel@1.1.0#lib')).toBe('pkg:npm/side-channel@1.1.0')
    })

    it('lowercases the type', () => {
        expect(normalizePurl('pkg:NPM/lodash@4.17.21')).toBe('pkg:npm/lodash@4.17.21')
    })

    it('spells an npm scope %40 whether it arrives encoded or not', () => {
        expect(normalizePurl('pkg:npm/%40babel/core@7.24.0')).toBe('pkg:npm/%40babel/core@7.24.0')
        expect(normalizePurl('pkg:npm/@babel/core@7.24.0')).toBe('pkg:npm/%40babel/core@7.24.0')
    })

    it('lowercases npm, composer and nuget names', () => {
        expect(normalizePurl('pkg:npm/%40Types/Node@20.1.0')).toBe('pkg:npm/%40types/node@20.1.0')
        expect(normalizePurl('pkg:composer/Symfony/Console@6.4.0')).toBe('pkg:composer/symfony/console@6.4.0')
        expect(normalizePurl('pkg:nuget/Newtonsoft.Json@13.0.3')).toBe('pkg:nuget/newtonsoft.json@13.0.3')
    })

    it('normalises pypi names per PEP 503', () => {
        expect(normalizePurl('pkg:pypi/Django_Filter@24.2')).toBe('pkg:pypi/django-filter@24.2')
        expect(normalizePurl('pkg:pypi/zope.interface@6.0')).toBe('pkg:pypi/zope-interface@6.0')
        expect(normalizePurl('pkg:pypi/a-._b@1')).toBe('pkg:pypi/a-b@1')
    })

    it('keeps maven and gem case', () => {
        expect(normalizePurl('pkg:maven/com.Example/My-Lib@1.0')).toBe('pkg:maven/com.Example/My-Lib@1.0')
        expect(normalizePurl('pkg:gem/RedCloth@4.3.2')).toBe('pkg:gem/RedCloth@4.3.2')
    })

    it('round-trips a cargo build-metadata version exactly as both tools write it', () => {
        const purl = 'pkg:cargo/tikv-jemalloc-sys@0.7.1%2B5.3.1-0-g81034ce1f1373e37dc865038e1bc8eeecf559ce8'
        expect(normalizePurl(purl)).toBe(purl)
        expect(normalizePurl('pkg:cargo/wasi@0.14.2+wasi-0.2.4')).toBe('pkg:cargo/wasi@0.14.2%2Bwasi-0.2.4')
    })

    it('keeps a golang version verbatim, v included', () => {
        expect(normalizePurl('pkg:golang/cel.dev/expr@v0.25.1')).toBe('pkg:golang/cel.dev/expr@v0.25.1')
    })

    it('restores golang case from the Trivy component name, so Trivy and Syft agree', () => {
        const syft = normalizePurl('pkg:golang/github.com/Masterminds/semver/v3@v3.4.0',
            {name: 'github.com/Masterminds/semver/v3', version: 'v3.4.0'})
        const trivy = normalizePurl('pkg:golang/github.com/masterminds/semver/v3@v3.4.0',
            {name: 'github.com/Masterminds/semver/v3', version: 'v3.4.0'})
        expect(syft).toBe('pkg:golang/github.com/Masterminds/semver/v3@v3.4.0')
        expect(trivy).toBe(syft)
    })

    it('also restores golang case from group + name, and ignores a name that is another path', () => {
        expect(normalizePurl('pkg:golang/github.com/burntsushi/toml@v1.6.0', {group: 'github.com/BurntSushi', name: 'toml'}))
            .toBe('pkg:golang/github.com/BurntSushi/toml@v1.6.0')
        expect(normalizePurl('pkg:golang/github.com/burntsushi/toml@v1.6.0', {name: 'github.com/Other/toml'}))
            .toBe('pkg:golang/github.com/burntsushi/toml@v1.6.0')
    })

    it('takes the component version for a versionless purl', () => {
        expect(normalizePurl('pkg:maven/org.apache.phoenix/phoenix-core', {version: '5.1.3'}))
            .toBe('pkg:maven/org.apache.phoenix/phoenix-core@5.1.3')
    })

    it('stays versionless rather than writing @UNKNOWN', () => {
        expect(normalizePurl('pkg:maven/org.apache.phoenix/phoenix-core', {version: 'UNKNOWN'}))
            .toBe('pkg:maven/org.apache.phoenix/phoenix-core')
        expect(normalizePurl('pkg:maven/org.apache.phoenix/phoenix-core@unknown'))
            .toBe('pkg:maven/org.apache.phoenix/phoenix-core')
        expect(normalizePurl('pkg:npm/@types/node')).toBe('pkg:npm/%40types/node')
    })

    it('returns undefined for anything that is not a purl', () => {
        expect(normalizePurl(undefined)).toBeUndefined()
        expect(normalizePurl('')).toBeUndefined()
        expect(normalizePurl('github.com/foo/bar@v1')).toBeUndefined()
        expect(normalizePurl('pkg:npm')).toBeUndefined()
        expect(normalizePurl('pkg:npm/')).toBeUndefined()
    })
})
