import {nullLogger} from '@depinder/core'
import {createDb, loadConfig, migrate, type Config, type Db} from 'depinder-server/in-process'

/** The server's own database for the parity run: next to TEST_DATABASE_URL's, never that one. */
const PARITY_DATABASE = 'depinder_parity'
const LOCAL_COMMAND =
    'TEST_DATABASE_URL=postgresql://postgres:depinder@127.0.0.1:55432/depinder npx nx test-parity parity'

export interface ParityDatabase {
    db: Db
    config: Config
}

/** Fails, never skips: a parity run without a database would pass having compared nothing. */
export function testDatabaseUrl(): string {
    const url = process.env.TEST_DATABASE_URL
    if (!url) {
        throw new Error(`TEST_DATABASE_URL is not set: parity needs a throwaway Postgres. Locally, with depinder-pg: ${LOCAL_COMMAND}`)
    }
    return url
}

/**
 * Creates the parity database when missing, applies the server's migrations and empties every
 * table. A database of its own keeps parity and the server's integration tests, which truncate
 * theirs, from emptying each other's tables when both run at once.
 */
export async function openParityDatabase(): Promise<ParityDatabase> {
    const testUrl = testDatabaseUrl()
    const admin = createDb(configFor(testUrl), 1)
    try {
        const existing = await admin.query('select 1 from pg_database where datname = $1', [PARITY_DATABASE])
        if (existing.length === 0) await admin.query(`create database ${PARITY_DATABASE}`)
    } finally {
        await admin.close()
    }

    const parityUrl = new URL(testUrl)
    parityUrl.pathname = `/${PARITY_DATABASE}`
    const config = configFor(parityUrl.toString())
    const db = createDb(config)
    await migrate(db, nullLogger)
    await db.query('truncate package, package_version, fetch_queue, fetch_log, registry_feed')
    return {db, config}
}

function configFor(databaseUrl: string): Config {
    return loadConfig({DATABASE_URL: databaseUrl, RESOLVER_API_TOKEN: 'parity'.repeat(4), DATABASE_SSL: 'false'})
}
