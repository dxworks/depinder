import {analyseFiles} from '../src/commands/analyse'

describe('test analyse for default plugins', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test analyse for javascript and ruby', async () => {

        await analyseFiles(['/Users/alexandraionel/Projects/testing'], {results:'results-test-mongo', refresh: true,
            plugins: ['npm']})

        console.log('done')
    }, 7200000)
})
