import {
    DEFAULT_PACKAGES_AT_ONCE,
    packagesAtOnce,
    parseRegistryLimits,
    resolveRegistryLimits,
} from '../src/fallback/registry-limits'
import {limitFor} from '@depinder/core'

describe('parseRegistryLimits', () => {
    it('reads concurrency and an optional minimum interval per purl type', () => {
        expect(parseRegistryLimits(' npm=16, cargo=1:1000 ,MAVEN=4', 'test')).toEqual({
            npm: {concurrency: 16, minIntervalMs: 0},
            cargo: {concurrency: 1, minIntervalMs: 1000},
            maven: {concurrency: 4, minIntervalMs: 0},
        })
    })

    it.each([undefined, '', '  '])('reads %j as no overrides', spec => {
        expect(parseRegistryLimits(spec, 'test')).toEqual({})
    })

    it.each([
        ['npm', 'expected <type>=<concurrency>'],
        ['npm=fast', 'expected <type>=<concurrency>'],
        ['npm=-1', 'expected <type>=<concurrency>'],
        ['npm=4:', 'expected <type>=<concurrency>'],
        ['npm=0', 'concurrency must be at least 1'],
        ['java=8', 'unknown type "java"'],
        ['npm=8,,maven=4', 'expected <type>=<concurrency>'],
    ])('rejects %j with a message naming the entry and the source', (spec, reason) => {
        expect(() => parseRegistryLimits(spec, '--registry-limits')).toThrow(reason)
        expect(() => parseRegistryLimits(spec, '--registry-limits')).toThrow('in --registry-limits')
    })
})

describe('resolveRegistryLimits', () => {
    it('is at least as fast as the old registrars by default', () => {
        const {limits, overrides} = resolveRegistryLimits({})
        for (const type of ['npm', 'maven', 'pypi', 'gem', 'cargo', 'composer']) {
            expect(limitFor(limits, type)).toEqual({concurrency: 8, minIntervalMs: 0})
        }
        expect(limitFor(limits, 'golang').concurrency).toBe(64)
        expect(limitFor(limits, 'nuget').concurrency).toBe(32)
        expect(overrides).toEqual({})
    })

    it('lays the env variable over the defaults and the flag over both', () => {
        const {limits} = resolveRegistryLimits({env: 'npm=16,maven=2', flag: 'maven=12,cargo=1:1000'})
        expect(limitFor(limits, 'npm')).toEqual({concurrency: 16, minIntervalMs: 0})
        expect(limitFor(limits, 'maven')).toEqual({concurrency: 12, minIntervalMs: 0})
        expect(limitFor(limits, 'cargo')).toEqual({concurrency: 1, minIntervalMs: 1000})
        expect(limitFor(limits, 'golang').concurrency).toBe(64)
    })

    it('names the env variable when its value is bad', () => {
        expect(() => resolveRegistryLimits({env: 'npm=lots'})).toThrow('DEPINDER_REGISTRY_LIMITS')
    })
})

describe('packagesAtOnce', () => {
    it('looks up the old 8 at once unless the user raised the limit', () => {
        const limits = resolveRegistryLimits({flag: 'npm=20,cargo=1'})
        expect(packagesAtOnce(limits, 'npm')).toBe(20)
        expect(packagesAtOnce(limits, 'cargo')).toBe(DEFAULT_PACKAGES_AT_ONCE)
        expect(packagesAtOnce(limits, 'golang')).toBe(DEFAULT_PACKAGES_AT_ONCE)
    })
})
