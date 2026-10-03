import {registryFallbackWith} from '../src/fallback/registry-fallback'
import {librariesIoFallback, LibrariesIoFallback} from '../src/fallback/libraries-io'
import {FallbackPackage, FallbackResult} from '../src/fallback/fetch-library-info'
import {LibraryInfo} from '../src/extension-points/library-info'

const library = (name: string, description: string): LibraryInfo => ({name, description, licenses: [], versions: []})
const LIBRARIES_IO_TYPES = ['maven', 'pypi', 'nuget', 'composer']
const NEVER_LIBRARIES_IO_TYPES = ['npm', 'gem', 'cargo', 'golang']

/** A Libraries.io that answers, with or without a key, the way the real one decides `covers`. */
function fakeLibrariesIo(hasKey: boolean): LibrariesIoFallback & {retrieve: ReturnType<typeof vi.fn>} {
    return {
        covers: type => hasKey && LIBRARIES_IO_TYPES.includes(type),
        retrieve: vi.fn(async (_type: string, name: string) => library(name, 'from libraries.io')),
    }
}

function fallbackOver(result: FallbackResult, librariesIo: LibrariesIoFallback) {
    const fetchInfo = vi.fn(async (_pkg: FallbackPackage) => result)
    return {fetchInfo, fallback: registryFallbackWith({fetchInfo, librariesIo, rateLimitDelaysMs: [1, 1]})}
}

describe('registry fallback dispatch', () => {
    it('returns what core found, without asking Libraries.io', async () => {
        const librariesIo = fakeLibrariesIo(true)
        const {fetchInfo, fallback} = fallbackOver({status: 'found', info: library('a:b', 'from core')}, librariesIo)

        await expect(fallback.lookup({type: 'maven', name: 'a:b'})).resolves.toMatchObject({description: 'from core'})
        expect(fetchInfo).toHaveBeenCalledWith({type: 'maven', name: 'a:b'})
        expect(librariesIo.retrieve).not.toHaveBeenCalled()
    })

    it.each(LIBRARIES_IO_TYPES)('hands a %s package core did not find to Libraries.io', async type => {
        const librariesIo = fakeLibrariesIo(true)
        const {fallback} = fallbackOver({status: 'not_found'}, librariesIo)

        await expect(fallback.lookup({type, name: 'pkg'})).resolves.toMatchObject({description: 'from libraries.io'})
        expect(librariesIo.retrieve).toHaveBeenCalledWith(type, 'pkg')
    })

    it.each(LIBRARIES_IO_TYPES)('hands a %s package core failed on to Libraries.io', async type => {
        const librariesIo = fakeLibrariesIo(true)
        const {fallback} = fallbackOver({status: 'error', error: new Error('boom')}, librariesIo)

        await expect(fallback.lookup({type, name: 'pkg'})).resolves.toMatchObject({description: 'from libraries.io'})
    })

    it.each(NEVER_LIBRARIES_IO_TYPES)('never sends a %s package to Libraries.io', async type => {
        const librariesIo = fakeLibrariesIo(true)
        const {fallback} = fallbackOver({status: 'not_found'}, librariesIo)

        await expect(fallback.lookup({type, name: 'pkg'})).rejects.toThrow(`pkg is not in the ${type} registry`)
        expect(librariesIo.retrieve).not.toHaveBeenCalled()
    })

    it('without a key, throws core\'s error and asks nobody else', async () => {
        const librariesIo = fakeLibrariesIo(false)
        const error = new Error('registry down')
        const {fallback} = fallbackOver({status: 'error', error}, librariesIo)

        await expect(fallback.lookup({type: 'pypi', name: 'pkg'})).rejects.toBe(error)
        expect(librariesIo.retrieve).not.toHaveBeenCalled()
    })

    it('retries a lookup that stays rate limited, then gives up with the 429', async () => {
        const error = Object.assign(new Error('429'), {status: 429})
        const {fetchInfo, fallback} = fallbackOver({status: 'error', error}, fakeLibrariesIo(false))

        await expect(fallback.lookup({type: 'npm', name: 'pkg'})).rejects.toBe(error)
        expect(fetchInfo).toHaveBeenCalledTimes(3)
    })
})

describe('librariesIoFallback', () => {
    const key = process.env.LIBRARIES_IO_API_KEY
    afterEach(() => {
        if (key === undefined) delete process.env.LIBRARIES_IO_API_KEY
        else process.env.LIBRARIES_IO_API_KEY = key
    })

    it('covers maven, pypi, nuget and composer only, and only with a key', () => {
        process.env.LIBRARIES_IO_API_KEY = 'test-key'
        const withKey = librariesIoFallback()
        expect(LIBRARIES_IO_TYPES.every(it => withKey.covers(it))).toBe(true)
        expect(NEVER_LIBRARIES_IO_TYPES.some(it => withKey.covers(it))).toBe(false)

        delete process.env.LIBRARIES_IO_API_KEY
        expect(LIBRARIES_IO_TYPES.some(it => librariesIoFallback().covers(it))).toBe(false)
    })

    it('asks Libraries.io under its platform name and maps the project to a LibraryInfo', async () => {
        process.env.LIBRARIES_IO_API_KEY = 'test-key'
        const project = {
            versions: [{number: '1.0.0', published_at: '2020-01-01T00:00:00Z'}, {number: '2.0.0', published_at: '2021-01-01T00:00:00Z'}],
            latest_release_number: '2.0.0', description: 'logging', licenses: 'MIT',
            homepage: 'https://example.org', repository_url: 'https://github.com/example/log', keywords: ['log'],
        }
        const fetchMock = vi.fn(async (_url: string) => ({json: async () => project}))
        vi.stubGlobal('fetch', fetchMock)
        try {
            const info = await librariesIoFallback().retrieve('composer', 'example/log')
            expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/libraries\.io\/api\/packagist\/example\/log\?api_key=/)
            expect(info).toEqual({
                name: 'example/log',
                versions: [
                    {version: '1.0.0', timestamp: Date.parse('2020-01-01T00:00:00Z'), latest: false, licenses: []},
                    {version: '2.0.0', timestamp: Date.parse('2021-01-01T00:00:00Z'), latest: true, licenses: []},
                ],
                description: 'logging', licenses: ['MIT'], homepageUrl: 'https://example.org',
                keywords: ['log'], reposUrl: ['https://github.com/example/log'],
            })
        } finally {
            vi.unstubAllGlobals()
        }
    })
})
