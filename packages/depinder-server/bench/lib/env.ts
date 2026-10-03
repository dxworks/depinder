import {readFileSync} from 'node:fs'
import {parseEnv} from 'node:util'

/**
 * Env files and the child environment depinder runs in.
 *
 * The bench never loads an env file into its own `process.env`: the values (a database password,
 * the API token) stay in one object, are handed only to the place that needs them, and are never
 * printed. What the bench does print about the database is its host name.
 */

export type EnvFile = Readonly<Record<string, string>>

/**
 * Reads an env file without touching `process.env`.
 *
 * `raw` matches compose's `format: raw` (deploy/compose.server.yml and bench/compose.deploy-db.yml):
 * everything after the first `=` is the value exactly as written, so a `$` in a password stays a
 * `$`. Otherwise Node's dotenv parser, which strips quotes and expands nothing.
 */
export function readEnvFile(file: string, raw: boolean): EnvFile {
    const text = readFileSync(file, 'utf8')
    if (!raw) {
        const parsed = parseEnv(text)
        return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => e[1] !== undefined))
    }
    const out: Record<string, string> = {}
    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '' || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        out[line.slice(0, eq).trim()] = line.slice(eq + 1)
    }
    return out
}

/**
 * The host of a connection string, the only part of it the bench ever prints. Supabase's session
 * pooler has one host name for every project in a region, so for it the project ref (the
 * `postgres.<ref>` user name, which is no secret: it is the project's public URL) is added — without
 * it the dev and the deployed database would print the same.
 */
export function dbHost(databaseUrl: string | undefined): string {
    if (!databaseUrl) return '(DATABASE_URL missing)'
    try {
        const url = new URL(databaseUrl)
        const ref = decodeURIComponent(url.username).match(/^postgres\.([a-z0-9]+)$/)?.[1]
        return (url.hostname || '(no host)') + (ref ? ` [project ${ref}]` : '')
    } catch {
        return '(unparseable DATABASE_URL)'
    }
}

/** The API token from an env file, checked for length; throws with a message that names no value. */
export function apiToken(env: EnvFile, file: string): string {
    const token = env.RESOLVER_API_TOKEN ?? ''
    if (token.length < 16) {
        throw new Error(`RESOLVER_API_TOKEN in ${file} is missing or shorter than 16 characters (length ${token.length})`)
    }
    return token
}

export interface ChildEnv {
    env: NodeJS.ProcessEnv
    /** Names (never values) of the variables removed, for run.json. */
    stripped: string[]
}

/**
 * The environment depinder runs in: the bench's own, minus everything that would make one run
 * differ from another for reasons outside the bench.
 *
 * - GitHub tokens: with one, depinder asks the GitHub advisory API per package, a network cost
 *   that depends on rate limits and has nothing to do with the resolver.
 * - DATABASE_URL and DEPINDER_RESOLVER_*: a stray resolver URL or token in the shell would point
 *   the run somewhere else; the bench passes the URL on the command line and sets the token here.
 * - RESOLVER_API_TOKEN: the server's name for the token; depinder's is DEPINDER_RESOLVER_TOKEN.
 */
export function childEnv(token: string, cacheDb: string): ChildEnv {
    const env: NodeJS.ProcessEnv = {...process.env}
    const stripped: string[] = []
    for (const key of Object.keys(env)) {
        const strip = key === 'GH_TOKEN' || key === 'GITHUB_TOKEN' || key.startsWith('GH_TOKEN_')
            || key === 'DATABASE_URL' || key === 'RESOLVER_API_TOKEN' || key.startsWith('DEPINDER_RESOLVER_')
        if (strip) {
            delete env[key]
            stripped.push(key)
        }
    }
    env.DEPINDER_RESOLVER_TOKEN = token
    env.DEPINDER_CACHE_DB = cacheDb
    return {env, stripped: stripped.sort()}
}
