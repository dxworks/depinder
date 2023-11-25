
describe('test analyse for default plugins', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test analyse for javascript and ruby', async () => {

        //todo fix this test
        // await analyseFilesToCache(['/Users/mario/test-projects/depinder/dxworks'], {results:'results-test-mongo', refresh: false,
        //     plugins: ['.net']})

        console.log('done')
    }, 7200000)
})
