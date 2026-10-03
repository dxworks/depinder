import {describe, expect, it} from 'vitest'
import {
    fromRegistryName,
    normalisePypiName,
    parsePurl,
    registryName,
    SUPPORTED_TYPES,
    tryParsePurl,
    versionPurl,
} from '../../src/shared/purl.js'

describe('parsePurl', () => {
    const cases: [string, {type: string; namespace: string | null; name: string; version: string | null; packageKey: string}][] = [
        ['pkg:npm/lodash@4.17.21', {type: 'npm', namespace: null, name: 'lodash', version: '4.17.21', packageKey: 'pkg:npm/lodash'}],
        ['pkg:npm/@babel/core@7.24.0', {type: 'npm', namespace: '@babel', name: 'core', version: '7.24.0', packageKey: 'pkg:npm/@babel/core'}],
        ['pkg:npm/%40babel/Core', {type: 'npm', namespace: '@babel', name: 'core', version: null, packageKey: 'pkg:npm/@babel/core'}],
        ['pkg:maven/com.google.guava/guava@32.1.2-jre', {type: 'maven', namespace: 'com.google.guava', name: 'guava', version: '32.1.2-jre', packageKey: 'pkg:maven/com.google.guava/guava'}],
        ['pkg:pypi/Zope.Interface@5.4.0', {type: 'pypi', namespace: null, name: 'zope-interface', version: '5.4.0', packageKey: 'pkg:pypi/zope-interface'}],
        ['pkg:pypi/typing_extensions', {type: 'pypi', namespace: null, name: 'typing-extensions', version: null, packageKey: 'pkg:pypi/typing-extensions'}],
        ['pkg:nuget/Newtonsoft.Json@13.0.3', {type: 'nuget', namespace: null, name: 'newtonsoft.json', version: '13.0.3', packageKey: 'pkg:nuget/newtonsoft.json'}],
        ['pkg:composer/Symfony/Console@6.4.0', {type: 'composer', namespace: 'symfony', name: 'console', version: '6.4.0', packageKey: 'pkg:composer/symfony/console'}],
        ['pkg:gem/Rails@7.1.0', {type: 'gem', namespace: null, name: 'Rails', version: '7.1.0', packageKey: 'pkg:gem/Rails'}],
        ['pkg:golang/github.com/gin-gonic/gin@v1.9.1', {type: 'golang', namespace: 'github.com/gin-gonic', name: 'gin', version: 'v1.9.1', packageKey: 'pkg:golang/github.com/gin-gonic/gin'}],
        ['pkg:cargo/serde_json@1.0.108', {type: 'cargo', namespace: null, name: 'serde_json', version: '1.0.108', packageKey: 'pkg:cargo/serde_json'}],
    ]

    for (const [input, expected] of cases) {
        it(`canonicalises ${input}`, () => {
            expect(parsePurl(input)).toEqual(expected)
        })
    }

    it('drops qualifiers and subpaths from the package key', () => {
        const parsed = parsePurl('pkg:maven/org.slf4j/slf4j-api@2.0.9?type=jar&classifier=sources#sub/dir')
        expect(parsed.packageKey).toBe('pkg:maven/org.slf4j/slf4j-api')
        expect(parsed.version).toBe('2.0.9')
    })

    it('is idempotent: a package key parses back to itself', () => {
        for (const [input] of cases) {
            const once = parsePurl(input).packageKey
            expect(parsePurl(once).packageKey).toBe(once)
        }
    })

    it('accepts golang versions that are not semver', () => {
        // packageurl-js 2.0.1's own golang validator throws a ReferenceError on these, which is
        // why parsePurl does not use fromString.
        expect(parsePurl('pkg:golang/github.com/x/y@v1').version).toBe('v1')
        expect(parsePurl('pkg:golang/github.com/x/y@master').version).toBe('master')
        expect(parsePurl('pkg:golang/github.com/x/y@v2.0.0+incompatible').version).toBe('v2.0.0+incompatible')
    })

    it('insists on a group id for maven', () => {
        expect(() => parsePurl('pkg:maven/guava@32.1.2-jre')).toThrow(/group id/)
    })

    it('rejects what is not a purl', () => {
        expect(() => parsePurl('express@4.18.2')).toThrow()
        expect(() => parsePurl('')).toThrow()
        expect(tryParsePurl('nonsense').ok).toBe(false)
        expect(tryParsePurl('pkg:npm/lodash').ok).toBe(true)
    })

    it('parses unsupported types without complaint; the API decides what to do with them', () => {
        expect(parsePurl('pkg:deb/debian/curl@7.50').type).toBe('deb')
        expect(SUPPORTED_TYPES).toHaveLength(8)
    })
})

describe('normalisePypiName', () => {
    it('follows PEP 503', () => {
        expect(normalisePypiName('Foo.Bar')).toBe('foo-bar')
        expect(normalisePypiName('foo___bar')).toBe('foo-bar')
        expect(normalisePypiName('foo-.-bar')).toBe('foo-bar')
        expect(normalisePypiName('ruamel.yaml.clib')).toBe('ruamel-yaml-clib')
    })
})

describe('registryName', () => {
    it('spells the name the way each registry wants it', () => {
        expect(registryName(parsePurl('pkg:maven/com.google.guava/guava@1'))).toBe('com.google.guava:guava')
        expect(registryName(parsePurl('pkg:npm/@babel/core@1'))).toBe('@babel/core')
        expect(registryName(parsePurl('pkg:npm/lodash@1'))).toBe('lodash')
        expect(registryName(parsePurl('pkg:composer/symfony/console@1'))).toBe('symfony/console')
        expect(registryName(parsePurl('pkg:golang/github.com/gin-gonic/gin@v1'))).toBe('github.com/gin-gonic/gin')
        expect(registryName(parsePurl('pkg:cargo/serde@1'))).toBe('serde')
        expect(registryName(parsePurl('pkg:gem/rails@1'))).toBe('rails')
        expect(registryName(parsePurl('pkg:pypi/django@1'))).toBe('django')
        expect(registryName(parsePurl('pkg:nuget/newtonsoft.json@1'))).toBe('newtonsoft.json')
    })
})

describe('fromRegistryName', () => {
    it('is the inverse of registryName', () => {
        for (const purl of [
            'pkg:maven/com.google.guava/guava',
            'pkg:npm/@babel/core',
            'pkg:npm/lodash',
            'pkg:composer/symfony/console',
            'pkg:golang/github.com/gin-gonic/gin',
            'pkg:cargo/serde',
            'pkg:pypi/django',
        ]) {
            const parsed = parsePurl(purl)
            expect(fromRegistryName(parsed.type, registryName(parsed)).packageKey).toBe(parsed.packageKey)
        }
    })

    it('canonicalises the name it is given', () => {
        expect(fromRegistryName('pypi', 'Typing_Extensions').packageKey).toBe('pkg:pypi/typing-extensions')
        expect(fromRegistryName('npm', '@Types/Node').packageKey).toBe('pkg:npm/@types/node')
    })

    it('insists on group:artifact for maven', () => {
        expect(() => fromRegistryName('maven', 'guava')).toThrow()
    })
})

describe('versionPurl', () => {
    it('appends the version', () => {
        expect(versionPurl('pkg:npm/@babel/core', '7.24.0')).toBe('pkg:npm/@babel/core@7.24.0')
        expect(versionPurl('pkg:pypi/foo', '1.0.0+local')).toBe('pkg:pypi/foo@1.0.0+local')
    })

    it('round-trips through the parser', () => {
        const purl = versionPurl('pkg:maven/com.google.guava/guava', '32.1.2-jre')
        expect(parsePurl(purl).version).toBe('32.1.2-jre')
    })
})
