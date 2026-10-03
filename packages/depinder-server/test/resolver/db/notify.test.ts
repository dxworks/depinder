import {EventEmitter} from 'node:events'
import {describe, expect, it} from 'vitest'
import {createResolverEvents} from '../../../src/resolver/events.js'
import {sleep} from '../../../src/resolver/registries/http.js'
import {nullLogger} from '@depinder/core'
import {CHANNEL_QUEUED, CHANNEL_SETTLED, CHANNEL_WANTED, startNotifyBridge, type ListenClient} from '../../../src/resolver/db/notify.js'

/**
 * The bridge from `LISTEN` to `ResolverEvents`, against a fake client: what it listens to, what it
 * replays, and that losing the connection is a reconnect rather than an end. That Postgres really
 * delivers on commit and drops on rollback is `db.integration.test.ts`'s to show.
 */

class FakeClient extends EventEmitter implements ListenClient {
    readonly queries: string[] = []
    ended = false
    constructor(private readonly fail = false) {
        super()
    }
    async connect(): Promise<void> {
        if (this.fail) throw new Error('connection refused')
    }
    async query(text: string): Promise<void> {
        this.queries.push(text)
    }
    async end(): Promise<void> {
        this.ended = true
    }
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2_000
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
        await sleep(2)
    }
}

describe('notify bridge', () => {
    it('listens on all three channels and replays what it hears into the events', async () => {
        const events = createResolverEvents()
        const settled: string[] = []
        let queued = 0
        const wanted: [string, number][] = []
        events.onSettled(key => settled.push(key))
        events.onQueued(() => queued++)
        events.onWanted((key, until) => wanted.push([key, until]))
        const client = new FakeClient()
        const bridge = startNotifyBridge({config: {databaseUrl: 'x', databaseSsl: false}, events, log: nullLogger, connect: () => client})

        await waitFor(() => bridge.status === 'connected', 'the bridge to connect')
        expect(client.queries).toEqual([`listen ${CHANNEL_QUEUED}`, `listen ${CHANNEL_SETTLED}`, `listen ${CHANNEL_WANTED}`])

        client.emit('notification', {channel: CHANNEL_QUEUED, payload: ''})
        client.emit('notification', {channel: CHANNEL_SETTLED, payload: 'pkg:npm/lodash'})
        client.emit('notification', {channel: CHANNEL_WANTED, payload: 'pkg:maven/org.slf4j/slf4j-api 1790000000000'})
        client.emit('notification', {channel: CHANNEL_WANTED, payload: 'garbled'})
        client.emit('notification', {channel: 'something_else', payload: 'pkg:npm/nope'})
        expect(queued).toBe(1)
        expect(settled).toEqual(['pkg:npm/lodash'])
        expect(wanted).toEqual([['pkg:maven/org.slf4j/slf4j-api', 1_790_000_000_000]])

        await bridge.stop()
        expect(client.ended).toBe(true)
        expect(bridge.status).toBe('off')
    })

    it('reconnects after the connection drops, and after a connect that fails', async () => {
        const clients = [new FakeClient(), new FakeClient(true), new FakeClient()]
        let next = 0
        const events = createResolverEvents()
        const bridge = startNotifyBridge({
            config: {databaseUrl: 'x', databaseSsl: false},
            events,
            log: nullLogger,
            connect: () => clients[next++]!,
            reconnectMinMs: 5,
        })
        await waitFor(() => bridge.status === 'connected', 'the first connection')

        clients[0]!.emit('error', new Error('terminating connection'))
        expect(bridge.status).toBe('reconnecting')
        expect(clients[0]!.ended).toBe(true)

        // The second client refuses; the third is the one that sticks.
        await waitFor(() => next === 3 && bridge.status === 'connected', 'the third connection')
        expect(clients[2]!.queries).toHaveLength(3)

        await bridge.stop()
        expect(clients[2]!.ended).toBe(true)
    })

    it('stays stopped when the connection is lost after stop()', async () => {
        const client = new FakeClient()
        let made = 0
        const bridge = startNotifyBridge({
            config: {databaseUrl: 'x', databaseSsl: false},
            events: createResolverEvents(),
            log: nullLogger,
            connect: () => {
                made++
                return client
            },
            reconnectMinMs: 1,
        })
        await waitFor(() => bridge.status === 'connected', 'the bridge to connect')
        await bridge.stop()
        client.emit('end')
        await sleep(10)
        expect(made).toBe(1)
        expect(bridge.status).toBe('off')
    })
})
