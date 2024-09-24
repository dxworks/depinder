import {analyseHistory} from '../src/commands/history/history'

describe('test history analysis for default plugins', () => {

    it('test history analysis for javascript and ruby', async () => {
        await analyseHistory(['...'], {
            results: 'results-history',
            refresh: false,
            plugins: ['npm'],
        })
        console.log('done')
    })
})
