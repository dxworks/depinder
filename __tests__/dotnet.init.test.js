"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotnet_1 = require("../src/plugins/dotnet");
const minimatch_1 = __importDefault(require("minimatch"));
describe('default test', () => {
    it('should pass', async () => {
        const res = await new dotnet_1.NugetRegistrar().retrieve('Unity');
        console.log(res);
    });
    it('should match just files with *proj extension', async () => {
        expect(dotnet_1.dotnet.extractor.files.some(it => (0, minimatch_1.default)('demo/test/test.csproj', it, { matchBase: true }))).toBeTruthy();
        expect(dotnet_1.dotnet.extractor.files.some(it => (0, minimatch_1.default)('demo/test/test.fsproj', it, { matchBase: true }))).toBeTruthy();
        expect(dotnet_1.dotnet.extractor.files.some(it => (0, minimatch_1.default)('demo/test/test.vbproj', it, { matchBase: true }))).toBeTruthy();
        expect(dotnet_1.dotnet.extractor.files.some(it => (0, minimatch_1.default)('demo/test/test.csproj.json', it, { matchBase: true }))).toBeFalsy();
        expect(dotnet_1.dotnet.extractor.files.some(it => (0, minimatch_1.default)('demo/test/test.fsproj.json', it, { matchBase: true }))).toBeFalsy();
        expect(dotnet_1.dotnet.extractor.files.some(it => (0, minimatch_1.default)('demo/test/test.vbproj.json', it, { matchBase: true }))).toBeFalsy();
    });
});
//# sourceMappingURL=dotnet.init.test.js.map