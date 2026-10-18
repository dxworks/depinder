import type {MockInstance} from 'vitest'
import {positiveNumberFromEnv} from '../src/utils/number-from-env'
import {log} from '../src/utils/logging'

const NAME = 'DEPINDER_TEST_ENV_NUMBER'

describe('positiveNumberFromEnv', () => {
    let warn: MockInstance
    beforeEach(() => {
        delete process.env[NAME]
        warn = vi.spyOn(log, 'warn').mockImplementation((() => log) as any)
    })
    afterEach(() => {
        warn.mockRestore()
        delete process.env[NAME]
    })

    const read = (raw: string | undefined, wholeNumber = false) => {
        if (raw === undefined) delete process.env[NAME]
        else process.env[NAME] = raw
        return positiveNumberFromEnv(NAME, 7, {unit: 'widgets', wholeNumber})
    }

    it('falls back without a warning when the variable is unset or blank', () => {
        expect(read(undefined)).toBe(7)
        expect(read('')).toBe(7)
        expect(read('   ')).toBe(7)
        expect(warn).not.toHaveBeenCalled()
    })

    it('takes a positive number, fractions included unless whole numbers are asked for', () => {
        expect(read('1500')).toBe(1500)
        expect(read(' 42 ')).toBe(42)
        expect(read('2.5')).toBe(2.5)
        expect(read('8', true)).toBe(8)
        expect(warn).not.toHaveBeenCalled()
    })

    it('ignores anything else with a warning naming the variable, the value and the unit', () => {
        for (const nonsense of ['soon', '0', '-1', 'Infinity']) expect(read(nonsense)).toBe(7)
        expect(read('2.5', true)).toBe(7)
        expect(warn).toHaveBeenCalledTimes(5)
        expect(warn).toHaveBeenCalledWith(`Ignoring ${NAME}=soon: not a positive number of widgets`)
        expect(warn).toHaveBeenLastCalledWith(`Ignoring ${NAME}=2.5: not a positive whole number of widgets`)
    })
})
