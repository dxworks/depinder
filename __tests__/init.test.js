"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const utils_1 = require("../src/utils/utils");
describe('walk dir test', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test;
    runOnlyLocally('should walk the entire dir', () => {
        const files = (0, utils_1.walkDir)('.');
        expect(files.length).toBeGreaterThan(20);
    });
});
//# sourceMappingURL=init.test.js.map