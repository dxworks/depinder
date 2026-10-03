import {json} from 'npm-registry-fetch'
import {retrieveFromNpm} from '../src/plugins/javascript'

jest.mock('npm-registry-fetch', () => ({json: jest.fn()}))

const packument = (license?: unknown) => ({
    name: 'cycle',
    license,
    'dist-tags': {latest: '1.0.3'},
    time: {'1.0.3': '2013-01-01T00:00:00Z'},
    versions: {'1.0.3': {version: '1.0.3'}},
})

describe('npm registrar licences', () => {
    it('gives [] rather than [undefined] for a package with no licence', async () => {
        (json as unknown as jest.Mock).mockResolvedValue(packument())
        const info = await retrieveFromNpm('cycle')
        expect(info.licenses).toEqual([])
        // What the SQLite cache stores and a warm run reads back: must not become [null].
        expect(JSON.parse(JSON.stringify(info)).licenses).toEqual([])
    })

    it('keeps a declared licence', async () => {
        (json as unknown as jest.Mock).mockResolvedValue(packument('MIT'))
        expect((await retrieveFromNpm('cycle')).licenses).toEqual(['MIT'])
    })
})
