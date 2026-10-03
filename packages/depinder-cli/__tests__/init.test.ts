import {walkDir} from '../src/utils/utils'

describe('walk dir test', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('should walk the entire dir', () => {
        const files = walkDir('.')

        expect(files.length).toBeGreaterThan(20)
    })
})
