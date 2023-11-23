"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vulnerabilities_1 = require("../src/utils/vulnerabilities");
describe('test vulnerabilities from Github', () => {
    it('get vulnerabilities for php', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromGithub)('COMPOSER', 'lcobucci/jwt');
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
    it('get vulnerabilities for npm', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromGithub)('NPM', 'axios');
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
    it('get vulnerabilities for npm with organisation', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromGithub)('NPM', '@angular/http');
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
    it('get vulnerabilities for rubygems', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromGithub)('RUBYGEMS', 'rails');
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
});
describe('test vulnerabilities from Sonatype', () => {
    it('get vulnerabilities for php', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromSonatype)(['pkg:composer/laravel/laravel@5.5.0']);
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
    it('get vulnerabilities for npm', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromSonatype)(['pkg:npm/axios@0.21.1', 'pkg:npm/%40angular/core@12.0.0']);
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
    it('get vulnerabilities for ruby', async () => {
        const result = await (0, vulnerabilities_1.getVulnerabilitiesFromSonatype)(['pkg:gem/rails@0.5.0']);
        console.log(JSON.stringify(result));
        expect(result).toBeTruthy();
    });
});
//# sourceMappingURL=vulnerabilities.test.js.map