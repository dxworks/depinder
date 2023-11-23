"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const java_1 = require("../src/plugins/java");
describe('test all Maven registries access', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test;
    runOnlyLocally('access Maven Central Registry', async () => {
        const result = await new java_1.MavenCentralRegistrar().retrieve('com.fasterxml.jackson.core:jackson-databind');
        console.log(result);
    }, 1000000);
});
//# sourceMappingURL=maven.registry.integration.test.js.map