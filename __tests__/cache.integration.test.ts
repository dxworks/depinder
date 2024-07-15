import {cacheDownAction, cacheInfoAction, cacheInitAction, cacheUpAction} from '../src/commands/cache'

describe('test cache commands', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test cache info', async () => {
        cacheInfoAction()
    })
    runOnlyLocally('test cache init', async () => {
        cacheInitAction()
    })
    runOnlyLocally('test cache up', async () => {
        await cacheUpAction()
    })
    runOnlyLocally('test cache down', async () => {
        await cacheDownAction()
    })
})
