import {coreFixture, serverFixture} from '../../fixtures.helpers.js'
import type {Config} from '../../../src/resolver/config.js'
import type {Db} from '../../../src/resolver/db/db.js'

/** What the database tests share: where the database is, the npm fixtures, a JSON answer. */

export const url = process.env.TEST_DATABASE_URL

export const express = JSON.parse(coreFixture('npm-express.json')) as unknown
export const changes = JSON.parse(serverFixture('npm-changes.json')) as unknown

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** The pool and config of the database under test, once the outer `beforeAll` has made them. */
export interface Postgres {
    db: Db
    config: Config
}
