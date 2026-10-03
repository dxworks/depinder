import {createServer} from './resolver/api/server.js'
import {loadConfigOrExit, poolSizes} from './resolver/config.js'
import {API_CONNECT_TIMEOUT_MS, createDb, migrate, type Db} from './resolver/db/db.js'
import {createResolverEvents} from './resolver/events.js'
import {createLogger, errorMessage} from './shared/log.js'
import {NO_BRIDGE, startNotifyBridge} from './resolver/db/notify.js'
import {startVuln} from './vuln/main.js'
import {startDemandFill} from './resolver/worker/fill/pool.js'
import {ensureFeedRows, startFeeds} from './resolver/worker/feeds.js'

/**
 * Boot. `ROLE` decides what runs: `api` serves HTTP, `worker` fills the queue and reads the
 * feeds, `all` (the default) does both in one process, which is what the compose file uses.
 * Migrations run on every boot in every role; they are guarded by an advisory lock.
 *
 * The api is built before the worker, and the two have things to say to each other, so the
 * `ResolverEvents` they share is made first and handed to both. Another process's half is heard
 * through `LISTEN/NOTIFY` (`src/resolver/db/notify.ts`), which replays what it hears into the same events; with
 * `DATABASE_LISTEN=false`, or while that connection is down, both halves fall back to the database
 * poll — see `src/resolver/events.ts`.
 *
 * What they do NOT share is a pool. Under `ROLE=all` the worker keeps up to `FETCH_CONCURRENCY`
 * writes in flight and would hold every client of a common pool; a request's `getPackages` then
 * waits in pg's pending queue and, after `connectionTimeoutMillis`, is rejected outright. So each
 * half gets its own pool out of the same `DATABASE_POOL_SIZE` ceiling — see `poolSizes`.
 *
 * `ROLE=vuln` is a different server altogether — the vulnerability scanner, with no Postgres — and
 * branches off before any of this: see `src/vuln/main.ts`.
 */
async function main(): Promise<void> {
    if (process.env.ROLE?.trim() === 'vuln') return startVuln()

    const config = loadConfigOrExit()
    const log = createLogger(config.logLevel, {role: config.role})
    const sizes = poolSizes(config)
    const apiDb = sizes.api > 0 ? createDb(config, sizes.api, API_CONNECT_TIMEOUT_MS) : undefined
    const workerDb = sizes.worker > 0 ? createDb(config, sizes.worker) : undefined
    const pools = [apiDb, workerDb].filter((d): d is Db => d !== undefined)
    const closeAll = (): Promise<unknown> => Promise.all(pools.map(d => d.close().catch(() => undefined)))

    try {
        // Either pool will do: migrations take one client and an advisory lock for the duration.
        const applied = await migrate(pools[0]!, log)
        log.info('database ready', {migrationsApplied: applied, apiPool: sizes.api, workerPool: sizes.worker})
    } catch (e) {
        log.error('migrations failed', {error: errorMessage(e)})
        await closeAll()
        process.exit(1)
    }

    const shutdown: {name: string; stop: () => Promise<unknown>}[] = []
    const events = createResolverEvents()
    const bridge = config.databaseListen ? startNotifyBridge({config, events, log}) : NO_BRIDGE

    if (apiDb) {
        const app = await createServer({db: apiDb, config, log, events, bridge})
        await app.listen({host: '0.0.0.0', port: config.port})
        log.info('api listening', {port: config.port})
        shutdown.push({name: 'api', stop: () => app.close()})
    }

    if (workerDb) {
        await ensureFeedRows(workerDb)
        const demandFill = startDemandFill({db: workerDb, log, config, events})
        const feeds = startFeeds({db: workerDb, log, config})
        shutdown.push({name: 'demand-fill', stop: () => demandFill.stop()})
        shutdown.push({name: 'feeds', stop: () => feeds.stop()})
        log.info('worker started')
    }
    // Last: nothing above needs to hear another process once it has stopped.
    shutdown.push({name: 'notify', stop: () => bridge.stop()})

    let stopping = false
    const stop = async (signal: string): Promise<void> => {
        if (stopping) return
        stopping = true
        log.info('shutting down', {signal})
        for (const part of shutdown) {
            await part.stop().catch(e => log.warn(`${part.name} did not stop cleanly`, {error: errorMessage(e)}))
        }
        await closeAll()
        log.info('stopped')
        process.exit(0)
    }

    process.on('SIGTERM', () => void stop('SIGTERM'))
    process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch(e => {
    process.stderr.write(`depinder-server-side: failed to start\n  ${errorMessage(e)}\n`)
    process.exit(1)
})
