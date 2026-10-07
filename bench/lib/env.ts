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
 * What the bench prints about a database: the target's name and the host with all but its last two
 * labels masked (`dev database (***.example.com)`). Run logs and run.json never carry the full host
 * or a project ref; a local host is shown as it is.
 */
export function maskedDbHost(target: string, databaseUrl: string | undefined): string {
    if (!databaseUrl) return `${target} database (DATABASE_URL missing)`
    try {
        const host = new URL(databaseUrl).hostname
        if (!host) return `${target} database (no host)`
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return `${target} database (${host})`
        return `${target} database (***.${host.split('.').slice(-2).join('.')})`
    } catch {
        return `${target} database (unparseable DATABASE_URL)`
    }
}

/** A driver error with the database's host and user name masked, so it can be printed. */
export function scrubDbDetails(message: string, databaseUrl: string | undefined): string {
    if (!databaseUrl) return message
    try {
        const url = new URL(databaseUrl)
        const secrets = [url.hostname, decodeURIComponent(url.username)].filter(it => it.length > 3)
        return secrets.reduce((text, secret) => text.split(secret).join('***'), message)
    } catch {
        return message
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
