import {errorMessage, nullLogger, parsePurl, registryName} from '@depinder/core'
import {replayFetch, type LoadedFixtureCase} from '@depinder/core/testing'
import {createRegistryClients, fetchLibraryInfo, toLibraryInfo, type LibraryInfo} from '@dxworks/depinder/fallback'
import {createServer, runOnce, type ResolveItem, type ResolveLine} from 'depinder-server/in-process'
import {vi} from 'vitest'
import type {ParityDatabase} from './parity-database.js'

/**
 * The two roads a package's facts take to `LibraryInfo`, each through the real code and with the
 * case's recorded registry answers as the only network: the CLI's fallback, and the server's fill
 * worker, database and `/resolve` followed by the CLI's adapter.
 */

export type RoadOutcome = {status: 'found', info: LibraryInfo} | {status: 'not_found'} | {status: 'failed', reason: string}

/** Fixed, so nothing the fallback stamps depends on when the test runs. */
const FETCHED_AT = new Date('2026-01-01T00:00:00.000Z')
const OPEN_LIMITS = {byType: {}, fallback: {concurrency: 8, minIntervalMs: 0}}

/** The CLI's fallback entry point, as `analyse` will call it for a package the resolver did not answer. */
export async function fallbackRoad(fixtureCase: LoadedFixtureCase): Promise<RoadOutcome> {
    vi.stubGlobal('fetch', replayFetch(fixtureCase))
    const key = parsePurl(fixtureCase.purl)
    const result = await fetchLibraryInfo(
        {type: key.type, name: registryName(key)},
        {clients: createRegistryClients({limits: OPEN_LIMITS}), log: nullLogger, now: () => FETCHED_AT},
    )
    if (result.status === 'error') return {status: 'failed', reason: errorMessage(result.error)}
    return result.status === 'found' ? {status: 'found', info: result.info} : {status: 'not_found'}
}

export interface ServerRoad {
    resolve(fixtureCase: LoadedFixtureCase): Promise<RoadOutcome>
    close(): Promise<void>
}

/** The server's api on the parity database; its fill worker runs one pass per case. */
export async function openServerRoad(database: ParityDatabase): Promise<ServerRoad> {
    const app = await createServer({...database, log: nullLogger})
    const authorization = `Bearer ${database.config.apiToken}`

    async function resolveLine(purl: string): Promise<ResolveItem> {
        const response = await app.inject({
            method: 'POST',
            url: '/resolve',
            headers: {authorization},
            payload: {purls: [purl], deadline_ms: 0},
        })
        if (response.statusCode !== 200) throw new Error(`/resolve answered ${response.statusCode}: ${response.body}`)
        const lines = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line) as ResolveLine)
        const item = lines.find((line): line is ResolveItem => !('done' in line))
        if (!item) throw new Error(`/resolve sent no line for ${purl}`)
        return item
    }

    return {
        async resolve(fixtureCase) {
            // The first ask finds nothing and queues the package, as for any caller.
            await resolveLine(fixtureCase.purl)
            vi.stubGlobal('fetch', replayFetch(fixtureCase))
            await runOnce({...database, log: nullLogger})
            const line = await resolveLine(fixtureCase.purl)
            if (line.status === 'resolved' && line.package) return {status: 'found', info: toLibraryInfo(line.package)}
            if (line.status === 'not_found') return {status: 'not_found'}
            return {status: 'failed', reason: `/resolve said ${line.status}${line.reason ? `: ${line.reason}` : ''}`}
        },
        close: () => app.close(),
    }
}
