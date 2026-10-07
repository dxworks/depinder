import {createRequire} from 'node:module'
import {dirname} from 'node:path'
import {listFixtureCases} from '@depinder/core/testing'
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest'
import {openParityDatabase, type ParityDatabase} from './parity-database.js'
import {fallbackRoad, openServerRoad, type ServerRoad} from './roads.js'

// Every recorded registry case, down both roads: the facts the CLI computes on its own must be the
// facts the server stores and serves. A difference is a bug on one of the two sides.

const CASES_DIR = dirname(createRequire(import.meta.url).resolve('@depinder/core/fixtures/cases/README.md'))
const cases = listFixtureCases(CASES_DIR)

describe('parity of the server road and the fallback road', () => {
    let database: ParityDatabase
    let server: ServerRoad

    beforeAll(async () => {
        database = await openParityDatabase()
        server = await openServerRoad(database)
    })

    afterAll(async () => {
        await server?.close()
        await database?.db.close()
    })

    afterEach(() => vi.unstubAllGlobals())

    it('has recorded cases to compare', () => {
        expect(cases.length).toBeGreaterThan(0)
    })

    it.each(cases.map(c => [c.id, c] as const))('%s', async (_id, fixtureCase) => {
        const expected = fixtureCase.expect === 'found' ? 'found' : 'not_found'

        const fallback = await fallbackRoad(fixtureCase)
        expect(fallback, 'fallback road').toMatchObject({status: expected})
        const served = await server.resolve(fixtureCase)
        expect(served, 'server road').toMatchObject({status: expected})

        expect(fallback).toStrictEqual(served)
    })
})
