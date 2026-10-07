import {fileURLToPath} from 'node:url'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {fetchPackage} from '../src/fetch-package.js'
import {parsePurl, SUPPORTED_TYPES} from '../src/purl.js'
import {listFixtureCases, replayFetch, UnrecordedRequestError} from '../src/testing/index.js'
import {testContext} from './registries/registry.helpers.js'

// Every recorded case replays through the real fetchPackage with nothing but its own answers,
// which proves each case is complete before the parity test relies on it.

const CASES_DIR = fileURLToPath(new URL('./fixtures/cases/', import.meta.url))
const cases = listFixtureCases(CASES_DIR)

afterEach(() => vi.unstubAllGlobals())

describe('fixture cases', () => {
    it('has a "not found" case for every supported ecosystem', () => {
        const notFound = new Set(cases.filter(c => c.expect === 'not_found').map(c => c.ecosystem))
        expect(SUPPORTED_TYPES.filter(type => !notFound.has(type))).toEqual([])
    })

    it.each(cases.map(c => [c.id, c] as const))('%s replays to its expected answer', async (_id, fixtureCase) => {
        vi.stubGlobal('fetch', replayFetch(fixtureCase))
        const pkg = await fetchPackage(parsePurl(fixtureCase.purl), testContext([]))

        expect(pkg ? 'found' : 'not_found').toBe(fixtureCase.expect)
        if (pkg) expect(pkg.versions.length).toBeGreaterThan(0)
    })

    it('rejects a request the case did not record, naming the URL', async () => {
        const replay = replayFetch(cases[0]!)
        await expect(replay('https://example.org/never-recorded')).rejects.toThrow(UnrecordedRequestError)
        await expect(replay('https://example.org/never-recorded')).rejects.toThrow('https://example.org/never-recorded')
    })
})
