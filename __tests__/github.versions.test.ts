import {
    compareGem,
    compareGeneric,
    comparePep440,
    compareSemver,
    comparatorFor,
    tokenizeVersion,
} from '../src/vuln-sources/github/versions'
import {parseRange, satisfiesRange} from '../src/vuln-sources/github/ranges'

/**
 * The version algebra is where a vulnerability matcher fails silently, so every comparator is
 * exercised through the same surface the matcher uses: a GitHub `vulnerable_version_range` string
 * plus a concrete version, answering "is this version affected?".
 */

describe('parseRange', () => {
    it('reads the operators GitHub emits', () => {
        expect(parseRange('< 1.2.3')).toEqual([{operator: '<', version: '1.2.3'}])
        expect(parseRange('>= 1.0, < 1.2.3')).toEqual([
            {operator: '>=', version: '1.0'},
            {operator: '<', version: '1.2.3'},
        ])
        expect(parseRange('= 1.0.0')).toEqual([{operator: '=', version: '1.0.0'}])
        expect(parseRange('<=2.4.1')).toEqual([{operator: '<=', version: '2.4.1'}])
    })

    it('treats a bare version as equality', () => {
        expect(parseRange('1.0.0')).toEqual([{operator: '=', version: '1.0.0'}])
    })

    it('rejects syntax GitHub does not emit rather than guessing', () => {
        expect(parseRange('^1.0.0')).toBeUndefined()
        expect(parseRange('~1.0')).toBeUndefined()
        expect(parseRange('>= 1.0 || < 0.9')).toBeUndefined()
        expect(parseRange('')).toBeUndefined()
    })

    it('never lets an unparseable range match everything', () => {
        expect(satisfiesRange('1.0.0', '^1.0.0', compareGeneric)).toBe(false)
    })
})

/** Every comparator answers the same eight-plus questions, in its own ecosystem's dialect. */
function expectRanges(compare: (a: string, b: string) => number, cases: [string, string, boolean][]): void {
    for (const [version, range, expected] of cases) {
        expect([version, range, satisfiesRange(version, range, compare)]).toEqual([version, range, expected])
    }
}

describe('npm / semver comparator', () => {
    it('matches the ranges GitHub publishes for npm', () => {
        expectRanges(compareSemver, [
            ['1.2.2', '< 1.2.3', true],
            ['1.2.3', '< 1.2.3', false],
            ['1.1.0', '>= 1.0.0, < 1.2.3', true],
            ['0.9.0', '>= 1.0.0, < 1.2.3', false],
            ['1.0.0', '= 1.0.0', true],
            ['1.0.1', '= 1.0.0', false],
            // A pre-release is below its release: rc1 is affected by `< 1.0.0`.
            ['1.0.0-rc1', '< 1.0.0', true],
            ['1.0.0', '<= 1.0.0', true],
            ['2.10.0', '> 2.9.0', true],
            ['2.9.9', '> 2.9.0', true],
            ['6.10.2', '>= 6.10.0, < 6.10.3', true],
            ['6.10.3', '>= 6.10.0, < 6.10.3', false],
        ])
    })

    it('falls back to the generic order for versions semver rejects', () => {
        // `1.0` is not valid semver; the generic comparator still orders it correctly.
        expect(compareSemver('1.0', '1.0.0')).toBe(0)
        expect(satisfiesRange('1.0', '< 1.1', compareSemver)).toBe(true)
    })
})

describe('pypi / PEP 440 comparator', () => {
    it('matches the ranges GitHub publishes for pip', () => {
        expectRanges(comparePep440, [
            ['1.0', '< 1.1', true],
            ['1.1', '< 1.1', false],
            // A post-release is ABOVE its release — the case a semver comparator gets wrong.
            ['1.0.post1', '> 1.0', true],
            ['1.0.post1', '< 1.0.1', true],
            ['1.0rc1', '< 1.0', true],
            ['1.0rc1', '>= 1.0', false],
            ['2.0.0', '>= 1.0, < 3.0', true],
            ['1.0.dev1', '< 1.0', true],
            ['2!1.0', '> 1.0', true],
            ['1.0', '= 1.0.0', true],
        ])
    })

    it('orders epochs, post- and pre-releases', () => {
        expect(comparePep440('1.0.post1', '1.0')).toBeGreaterThan(0)
        expect(comparePep440('1.0rc1', '1.0')).toBeLessThan(0)
        expect(comparePep440('2!1.0', '99.0')).toBeGreaterThan(0)
    })
})

describe('rubygems / Gem::Version comparator', () => {
    it('matches the ranges GitHub publishes for rubygems', () => {
        expectRanges(compareGem, [
            ['1.13.8', '< 1.13.9', true],
            ['1.13.9', '< 1.13.9', false],
            // Gem pre-release syntax is a dotted segment, not a hyphen.
            ['1.0.0.pre', '< 1.0.0', true],
            ['1.0.0.pre', '>= 1.0.0', false],
            ['1.2.3.beta1', '< 1.2.3', true],
            ['2.10.0', '> 2.9.0', true],
            ['4.3.4', '>= 4.3.0, < 4.3.5', true],
            ['4.3.5', '>= 4.3.0, < 4.3.5', false],
            ['5.2.4.4', '<= 5.2.4.4', true],
            ['1.0.0', '= 1.0.0', true],
        ])
    })

    it('places a .pre segment below its release', () => {
        expect(compareGem('1.0.0.pre', '1.0.0')).toBeLessThan(0)
        expect(compareGem('1.0.0.beta1', '1.0.0.beta2')).toBeLessThan(0)
    })
})

describe('generic comparator (maven, nuget, composer, go, cargo)', () => {
    it('matches the ranges GitHub publishes for those ecosystems', () => {
        expectRanges(compareGeneric, [
            ['2.9.10.3', '>= 2.9.0, < 2.9.10.4', true],
            ['2.9.10.4', '>= 2.9.0, < 2.9.10.4', false],
            // Numeric segments compare numerically, not lexically.
            ['2.10', '> 2.9', true],
            ['2.9', '> 2.10', false],
            // A pre-release qualifier is below its release, however it is spelled.
            ['1.0.0-rc1', '< 1.0.0', true],
            ['1.0.0-SNAPSHOT', '< 1.0.0', true],
            ['1.0.0.RELEASE', '>= 1.0.0', true],
            // `sp` (service pack) is the one qualifier ABOVE the release.
            ['1.0.0-sp1', '> 1.0.0', true],
            ['1.0', '= 1.0.0', true],
            ['v1.4.2', '< 1.5.0', true],
            ['4.1.100.Final', '>= 4.1.0, < 4.1.101', true],
            ['13.0.1', '>= 13.0.0, <= 13.0.3', true],
        ])
    })

    it('orders qualifiers alpha < beta < milestone < rc < snapshot < release < sp', () => {
        const ordered = ['1.0-alpha', '1.0-beta', '1.0-milestone', '1.0-rc', '1.0-snapshot', '1.0', '1.0-sp']
        for (let i = 1; i < ordered.length; i++) {
            expect([ordered[i - 1], ordered[i], compareGeneric(ordered[i - 1], ordered[i])])
                .toEqual([ordered[i - 1], ordered[i], -1])
        }
    })

    it('treats trailing zero segments and separator style as insignificant', () => {
        expect(compareGeneric('1.0', '1.0.0')).toBe(0)
        expect(compareGeneric('1.0.0rc1', '1.0.0-rc-1')).toBe(0)
        expect(compareGeneric('1.0.0+build.5', '1.0.0')).toBe(0)
    })

    it('tokenises at digit/letter boundaries and strips a leading v', () => {
        expect(tokenizeVersion('v1.0.0rc1')).toEqual([
            {kind: 'num', value: 1}, {kind: 'num', value: 0}, {kind: 'num', value: 0},
            {kind: 'str', value: 'rc'}, {kind: 'num', value: 1},
        ])
    })
})

describe('comparatorFor', () => {
    it('gives each family its own comparator', () => {
        expect(comparatorFor('semver')).toBe(compareSemver)
        expect(comparatorFor('pep440')).toBe(comparePep440)
        expect(comparatorFor('gem')).toBe(compareGem)
        expect(comparatorFor('generic')).toBe(compareGeneric)
    })

    it('never throws on input no library can parse', () => {
        for (const family of ['semver', 'pep440', 'gem', 'generic'] as const) {
            expect(() => comparatorFor(family)('UNKNOWN', '1.0.0')).not.toThrow()
        }
    })
})
