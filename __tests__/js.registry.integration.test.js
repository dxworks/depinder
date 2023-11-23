"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const javascript_1 = require("../src/plugins/javascript");
describe('test Npm registry access', () => {
    it('access npm registry', async () => {
        const result = await (0, javascript_1.retrieveFromNpm)('axios');
        console.log(result);
    }, 1000000);
});
//# sourceMappingURL=js.registry.integration.test.js.map