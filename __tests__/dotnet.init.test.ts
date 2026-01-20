import {dotnet, NugetRegistrar} from '../src/plugins/dotnet'
import { minimatch } from 'minimatch'

describe('default test', () => {
    it('should pass', async () => {
        const res = await new NugetRegistrar().retrieve('Unity')

        console.log(res)
    })

    it('should match just files with *proj extension', async () => {
        expect(dotnet.extractor.files.some(it => minimatch('demo/test/test.csproj', it, {matchBase: true}))).toBeTruthy()
        expect(dotnet.extractor.files.some(it => minimatch('demo/test/test.fsproj', it, {matchBase: true}))).toBeTruthy()
        expect(dotnet.extractor.files.some(it => minimatch('demo/test/test.vbproj', it, {matchBase: true}))).toBeTruthy()
        expect(dotnet.extractor.files.some(it => minimatch('demo/test/test.csproj.json', it, {matchBase: true}))).toBeFalsy()
        expect(dotnet.extractor.files.some(it => minimatch('demo/test/test.fsproj.json', it, {matchBase: true}))).toBeFalsy()
        expect(dotnet.extractor.files.some(it => minimatch('demo/test/test.vbproj.json', it, {matchBase: true}))).toBeFalsy()
    })
})
