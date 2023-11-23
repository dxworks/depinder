"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const php_1 = require("../src/plugins/php");
describe('test Packagist registries access', () => {
    it('access Packagist Registry', async () => {
        const result = await new php_1.PackagistRegistrar().retrieve('laravel/laravel');
        console.log(result);
    }, 1000000);
});
//# sourceMappingURL=php.registry.integration.test.js.map