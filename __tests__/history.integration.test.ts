import {analyseHistory} from '../src/commands/history/history'
jest.setTimeout(100000000);
describe('test history analysis for default plugins', () => {

    it('test history analysis for javascript and ruby', async () => {
        await analyseHistory(['/Users/avram/GreenSpace-Be'], {
            results: 'results-history',
            refresh: false,
            plugins: ['npm', 'java'],
        });
        console.log('done');
    });
});
