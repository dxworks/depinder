"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ruby_1 = require("../src/plugins/ruby");
describe('test Rubygems registry access', () => {
    it('access Rubygems registry', async () => {
        const result = await (0, ruby_1.retrieveFormRubyGems)('rails');
        console.log(result);
    }, 1000000);
});
//# sourceMappingURL=ruby.registry.integration.test.js.map