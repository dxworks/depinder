import {analyseFiles} from '../src/commands/analyse'

describe('test analyse for default plugins', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test analyse for javascript', async () => {

        await analyseFiles(['/Users/mario//test-projects/habitica'], {results:'demo/habitica', refresh: false,
            plugins: ['npm']})

        console.log('done')
    }, 7200000)
})
