"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const python_1 = require("../src/plugins/python");
describe('test PyPi registry access', () => {
    it('access PyPi registry', async () => {
        const result = await python_1.pythonRegistrar.retrieve('requests');
        console.log(result);
    }, 1000000);
});
//# sourceMappingURL=pypi.registry.integration.test.js.map