"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const analyse_1 = require("../src/commands/analyse");
describe('test analyse for default plugins', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test;
    runOnlyLocally('test analyse for javascript and ruby', async () => {
        await (0, analyse_1.analyseFiles)(['/Users/mario/test-projects/depinder/dxworks'], { results: 'results-test-mongo', refresh: false,
            plugins: ['.net'] });
        console.log('done');
    }, 7200000);
});
//# sourceMappingURL=analyse.integration.test.js.map