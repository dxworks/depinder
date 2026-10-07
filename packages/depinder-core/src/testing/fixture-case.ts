import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

/**
 * Recorded registry answers, one "case" per package, under `test/fixtures/cases/<case-id>/`:
 * a `case.json` plus the bodies as received. Replaying a case serves exactly those answers to
 * `fetch`, so any code that fetches the package through core can run offline.
 */

export type FixtureExpectation = 'found' | 'not_found'

/** One response as the registry sent it. `body` names a file next to `case.json`. */
export interface RecordedResponse {
    method: string
    url: string
    status: number
    headers: Record<string, string>
    /** Absent when the registry sent no body. */
    body?: string
}

export interface FixtureCase {
    purl: string
    /** Core's registry name, i.e. the purl type. */
    ecosystem: string
    /** One line: what this case protects. */
    pattern: string
    expect: FixtureExpectation
    recordedAt: string
    responses: RecordedResponse[]
}

/** A case read from disk, with the folder it lives in. */
export interface LoadedFixtureCase extends FixtureCase {
    id: string
    dir: string
}

export const FIXTURE_CASE_FILE = 'case.json'

/** Thrown by a replaying `fetch` for a request the case has no answer for. */
export class UnrecordedRequestError extends Error {
    constructor(readonly caseId: string, readonly method: string, readonly url: string) {
        super(`fixture case ${caseId} has no recorded answer for ${method} ${url}`)
        this.name = 'UnrecordedRequestError'
    }
}

export function loadFixtureCase(caseDir: string): LoadedFixtureCase {
    const recorded = JSON.parse(readFileSync(join(caseDir, FIXTURE_CASE_FILE), 'utf8')) as FixtureCase
    const id = caseDir.split(/[\\/]/).filter(Boolean).at(-1) ?? caseDir
    return {...recorded, id, dir: caseDir}
}

/** Every case folder under `casesDir`, sorted by id. */
export function listFixtureCases(casesDir: string): LoadedFixtureCase[] {
    return readdirSync(casesDir, {withFileTypes: true})
        .filter(entry => entry.isDirectory() && existsSync(join(casesDir, entry.name, FIXTURE_CASE_FILE)))
        .map(entry => entry.name)
        .sort()
        .map(name => loadFixtureCase(join(casesDir, name)))
}

/**
 * A `fetch` that answers only from the case's recordings, matched by method and exact URL. A URL
 * recorded more than once is answered in recorded order, its last answer repeating. Anything not
 * recorded rejects with `UnrecordedRequestError`, so an incomplete case fails loudly.
 */
export function replayFetch(fixtureCase: LoadedFixtureCase): typeof fetch {
    const queues = new Map<string, RecordedResponse[]>()
    for (const response of fixtureCase.responses) {
        const key = requestKey(response.method, response.url)
        queues.set(key, [...(queues.get(key) ?? []), response])
    }

    return async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
        const queue = queues.get(requestKey(method, url))
        if (!queue) throw new UnrecordedRequestError(fixtureCase.id, method, url)
        const recorded = queue.length > 1 ? queue.shift()! : queue[0]!
        const body = recorded.body ? readFileSync(join(fixtureCase.dir, recorded.body)) : null
        return new Response(body, {status: recorded.status, headers: recorded.headers})
    }
}

function requestKey(method: string, url: string): string {
    return `${method.toUpperCase()} ${url}`
}
