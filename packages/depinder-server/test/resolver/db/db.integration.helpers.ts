import {readFileSync} from 'node:fs'
import type {Config} from '../../../src/resolver/config.js'
import type {Db} from '../../../src/resolver/db/db.js'

/** What the database tests share: where the database is, the npm fixtures, a JSON answer. */

export const url = process.env.TEST_DATABASE_URL

export const express = JSON.parse(readFileSync(new URL('../../fixtures/npm-express.json', import.meta.url), 'utf8')) as unknown
export const changes = JSON.parse(readFileSync(new URL('../../fixtures/npm-changes.json', import.meta.url), 'utf8')) as unknown

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})
}

/** The pool and config of the database under test, once the outer `beforeAll` has made them. */
export interface Postgres {
    db: Db
    config: Config
}
