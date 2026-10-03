import axios from 'axios'
import {NugetRegistrar, NUGET_REGISTRATION_URL} from '../src/plugins/dotnet'

describe('default test', () => {
    it('should pass', async () => {
        const res = await new NugetRegistrar().retrieve('Unity')

        // console.log(res)
    })

})

describe('registration hive', () => {
    it('asks the semver2 hive, which lists the versions semver1 hides', async () => {
        const registrar = new NugetRegistrar()
        // A SemVer 2.0.0 version (build metadata) alongside a plain one: the semver1 hive would
        // have dropped the former and the dependency on it would have had no release date.
        const index = {items: [{items: [
            {catalogEntry: {id: 'Meta', version: '1.0.0', published: '2020-01-01T00:00:00Z'}},
            {catalogEntry: {id: 'Meta', version: '1.1.0+build.7', published: '2020-02-01T00:00:00Z'}},
        ]}]}
        const spy = vi.spyOn(axios, 'get').mockImplementation(async () => ({data: index}))
        try {
            const info = await registrar.retrieveFromRegistry('Meta')
            expect(spy).toHaveBeenCalledWith(`${NUGET_REGISTRATION_URL}/meta/index.json`)
            expect(NUGET_REGISTRATION_URL).toContain('semver2')
            expect(info.versions.map(it => it.version)).toEqual(['1.1.0+build.7', '1.0.0'])
            expect(info.versions.every(it => typeof it.timestamp === 'number' && it.timestamp > 0)).toBe(true)
        } finally {
            spy.mockRestore()
        }
    })
})

describe('paged registration index', () => {
    const entry = (version: string, projectUrl?: string) => ({
        catalogEntry: {id: 'Big', version, published: `2020-01-0${version}T00:00:00Z`, projectUrl},
    })

    it('follows a page that only links its versions', async () => {
        const registrar = new NugetRegistrar()
        const spy = vi.spyOn(axios, 'get').mockImplementation(async (url: any) => ({
            data: url === 'https://example/page2' ? {items: [entry('2', 'https://big.example')]} : {},
        }))
        try {
            const index = {items: [{items: [entry('1')]}, {'@id': 'https://example/page2', count: 1}]}
            const info = registrar.parseData(await registrar.inlinePages(index))
            expect(info.versions.map(it => it.version)).toEqual(['2', '1'])
            expect(info.homepageUrl).toBe('https://big.example')
            expect(spy).toHaveBeenCalledWith('https://example/page2')
        } finally {
            spy.mockRestore()
        }
    })
})

describe('unlisted versions', () => {
    it('keeps an unlisted version, marked yanked, without the 1900 sentinel as its date', () => {
        // Blazored.LocalStorage on nuget.org, trimmed: 4.5.0 is unlisted, and its registration
        // entry says so with `listed: false` and `published` 1900-01-01.
        const index = {items: [{items: [
            {catalogEntry: {id: 'Blazored.LocalStorage', version: '4.4.0', published: '2023-07-31T20:39:39.37+00:00', listed: true}},
            {catalogEntry: {id: 'Blazored.LocalStorage', version: '4.5.0', published: '1900-01-01T00:00:00+00:00', listed: false}},
            {catalogEntry: {id: 'Blazored.LocalStorage', version: '5.0.0', published: '2025-12-26T21:39:00+00:00', listed: true}},
        ]}]}
        const info = new NugetRegistrar().parseData(index)
        expect(info.versions.map(it => [it.version, it.latest, !!it.yanked]))
            .toEqual([['5.0.0', true, false], ['4.4.0', false, false], ['4.5.0', false, true]])
        expect(Number.isNaN(info.versions[2].timestamp)).toBe(true)
        expect(info.versions[1].timestamp).toBe(Date.parse('2023-07-31T20:39:39.37Z'))
    })
})
