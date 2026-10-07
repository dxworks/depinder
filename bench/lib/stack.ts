import {spawnSync} from 'node:child_process'
import {readdirSync, statSync} from 'node:fs'
import path from 'node:path'
import {setTimeout as sleep} from 'node:timers/promises'
import {MONOREPO_DIR, SERVER_DIR, type Target} from './targets.js'

/**
 * The server side of a run: bringing the local stack up on the target's database, waiting for it to
 * be healthy, stopping and starting the resolver around a wipe, and saying which image it runs.
 */

export const IMAGE = 'depinder-server:0.2.0'

/**
 * Runs a command with its output on the bench's terminal; throws if it fails or outlives
 * `timeoutMs` (killed then). stdin is closed: nothing the bench runs may wait for a person.
 */
export function sh(argv: string[], cwd = SERVER_DIR, timeoutMs = 5 * 60_000): void {
    const [cmd, ...args] = argv
    const res = spawnSync(cmd, args, {cwd, stdio: ['ignore', 'inherit', 'inherit'], timeout: timeoutMs, killSignal: 'SIGKILL'})
    if (res.error && (res.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        throw new Error(`${argv.join(' ')} timed out after ${timeoutMs / 1000} s`)
    }
    if (res.status !== 0) throw new Error(`${argv.join(' ')} failed (exit ${res.status ?? res.signal ?? res.error?.message})`)
}

/** Runs a command and returns its trimmed stdout, or null if it failed or took over a minute. */
export function capture(argv: string[], cwd = SERVER_DIR): string | null {
    const [cmd, ...args] = argv
    const res = spawnSync(cmd, args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, killSignal: 'SIGKILL'})
    return res.status === 0 ? res.stdout.trim() : null
}

/**
 * Local targets only: `docker compose up -d` on the target's files. Idempotent, and it recreates
 * a container whose env file changed — which is how a switch from `deploy` back to `dev` puts the
 * stack on the right database.
 */
export function stackUp(target: Target, rebuild: boolean): void {
    if (!target.composeFiles) return
    if (rebuild) sh(['docker', 'compose', ...target.composeFiles, 'build'], SERVER_DIR, 30 * 60_000)
    sh(['docker', 'compose', ...target.composeFiles, 'up', '-d'], SERVER_DIR, 5 * 60_000)
}

export interface Health {
    ok: boolean
    status: number | null
    body: unknown
}

export async function getHealth(url: string): Promise<Health> {
    try {
        const res = await fetch(url, {signal: AbortSignal.timeout(10_000)})
        const text = await res.text()
        let body: unknown = text
        try { body = JSON.parse(text) } catch { /* keep the text */ }
        const status = (body as {status?: unknown} | null)?.status
        // The vuln server answers 200 with `stale` too: still serving, which is all a run needs.
        return {ok: res.ok && (status === 'ok' || status === 'stale'), status: res.status, body}
    } catch (e) {
        return {ok: false, status: null, body: (e as Error).message}
    }
}

/**
 * Polls `/health` and `/vuln/health` until both are OK; throws after `timeoutMs`. Prints a line
 * when the state changes and every 30 s otherwise, so a long wait is visibly a wait.
 */
export async function waitHealthy(target: Target, timeoutMs = 10 * 60_000): Promise<Health> {
    const started = Date.now()
    const until = started + timeoutMs
    let last = ''
    let lastLine = 0
    for (;;) {
        const [api, vuln] = await Promise.all([getHealth(`${target.url}/health`), getHealth(`${target.url}/vuln/health`)])
        if (api.ok && vuln.ok) return vuln
        const now = `resolver ${api.status ?? 'down'}, vuln ${vuln.status ?? 'down'}`
        if (now !== last || Date.now() - lastLine > 30_000) {
            console.log(`  waiting for health: ${now} (${Math.round((Date.now() - started) / 1000)} s)`)
            lastLine = Date.now()
        }
        last = now
        if (Date.now() > until) throw new Error(`stack not healthy after ${timeoutMs / 1000}s (${now})`)
        await sleep(3_000)
    }
}

/** Stops the resolver (so nothing writes during a wipe), or starts it again. */
export function resolverStop(target: Target): void { sh(target.stopResolver) }
export function resolverStart(target: Target): void { sh(target.startResolver) }

/** The local image's Created time, or null (no image, or a hosted target). */
export function imageCreated(target: Target): string | null {
    if (!target.composeFiles) return null
    return capture(['docker', 'image', 'inspect', IMAGE, '--format', '{{.Created}}'])
}

/** The newest file modification time under `dir`, for "is the build older than its source". */
export function newestMtime(dir: string): number {
    let newest = 0
    for (const entry of readdirSync(dir, {withFileTypes: true, recursive: true})) {
        if (!entry.isFile()) continue
        newest = Math.max(newest, statSync(path.join(entry.parentPath, entry.name)).mtimeMs)
    }
    return newest
}

/**
 * A warning (never a failure) when the image is older than the code it should contain: a bench of
 * yesterday's image against today's source measures the wrong thing. `--rebuild` fixes it.
 */
export function imageStaleness(created: string | null): string | null {
    if (!created) return null
    const builtAt = Date.parse(created)
    const head = Date.parse(capture(['git', 'log', '-1', '--format=%cI', '--', 'packages/depinder-server'], MONOREPO_DIR) ?? '')
    const src = newestMtime(path.join(SERVER_DIR, 'src'))
    const reasons: string[] = []
    if (head > builtAt) reasons.push(`the last server commit (${new Date(head).toISOString()})`)
    if (src > builtAt) reasons.push(`a file under src/ (${new Date(src).toISOString()})`)
    if (reasons.length === 0) return null
    return `image ${IMAGE} (built ${new Date(builtAt).toISOString()}) is older than ${reasons.join(' and ')}; pass --rebuild`
}
