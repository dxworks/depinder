import {AbstractRegistrar, LibrariesIORegistrar, LibraryInfo} from '../src/extension-points/registrar'

class Failing extends AbstractRegistrar {
    retrieveFromRegistry(libraryName: string): LibraryInfo {
        throw new Error(`primary cannot find ${libraryName}`)
    }
}

class CountingLibrariesIO extends LibrariesIORegistrar {
    calls = 0
    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        this.calls++
        return {name: libraryName, versions: [], licenses: []}
    }
}

describe('the registrar fallback chain', () => {
    const key = process.env.LIBRARIES_IO_API_KEY

    afterEach(() => {
        if (key === undefined) delete process.env.LIBRARIES_IO_API_KEY
        else process.env.LIBRARIES_IO_API_KEY = key
    })

    it('does not ask libraries.io when no API key is configured, and rethrows the primary error', async () => {
        delete process.env.LIBRARIES_IO_API_KEY
        const fallback = new CountingLibrariesIO('maven')
        await expect(new Failing(fallback).retrieve('org.example:lib'))
            .rejects.toThrow('primary cannot find org.example:lib')
        expect(fallback.calls).toBe(0)
    })

    it('still falls back to libraries.io when a key is configured', async () => {
        process.env.LIBRARIES_IO_API_KEY = 'test-key'
        const fallback = new CountingLibrariesIO('maven')
        await expect(new Failing(fallback).retrieve('org.example:lib'))
            .resolves.toMatchObject({name: 'org.example:lib'})
        expect(fallback.calls).toBe(1)
    })

    it('always uses a fallback that does not say whether it is configured', async () => {
        delete process.env.LIBRARIES_IO_API_KEY
        const fallback = {retrieve: jest.fn(async (name: string) => ({name, versions: [], licenses: []}))}
        await new Failing(fallback).retrieve('x')
        expect(fallback.retrieve).toHaveBeenCalledWith('x')
    })
})
