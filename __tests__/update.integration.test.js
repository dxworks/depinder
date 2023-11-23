"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const update_1 = require("../src/commands/update");
describe('test update for default plugins', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test;
    runOnlyLocally('test update all plugins', async () => {
        await (0, update_1.updateLibs)('2023-09-23', ['gem']);
        console.log('done');
    }, 7200000);
});
//# sourceMappingURL=update.integration.test.js.map