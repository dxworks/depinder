import {updateLibs} from '../src/commands/update'

describe('test update for default plugins', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test update all plugins', async () => {

        await updateLibs('2023-09-23',['gem'])

        console.log('done')
    }, 7200000)
})
