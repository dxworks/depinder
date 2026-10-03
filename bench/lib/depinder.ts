import {spawn} from 'node:child_process'
import {closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {childEnv} from './env.js'
import {parseProfile, pick, type Picks, type Profile} from './profile.js'
import {capture, newestMtime, sh} from './stack.js'
import {INPUT_DIR, MONOREPO_DIR} from './targets.js'

/**
 * The client side of a run: checking that depinder's dist is the code on its branch, and running
 * `depinder analyse` once with its output, log and SQLite cache where the bench wants them.
 */

export const EXPECTED_BRANCH = 'feature/depinder-rework'

/** The CLI's Nx project in the monorepo; its build lands in dist/. */
export const DEPINDER_CLI_DIR = path.join(MONOREPO_DIR, 'packages', 'depinder-cli')
const BUILD_COMMAND = ['npx', 'nx', 'build', 'depinder-cli']

export interface GitInfo {
    sha: string | null
    branch: string | null
    /** Tracked files changed; untracked files (the owner's local notes) do not count. */
    dirty: boolean
}

export function gitInfo(dir: string): GitInfo {
    const status = capture(['git', 'status', '--porcelain', '--untracked-files=no'], dir)
    return {
        sha: capture(['git', 'rev-parse', 'HEAD'], dir),
        branch: capture(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir),
        dirty: status === null ? false : status.length > 0,
    }
}

/**
 * Fails when the CLI's dist/ is missing or older than its src/ (a run of stale JavaScript would be
 * credited to code it does not contain), unless `build` is set, which builds it first. Returns the
 * warnings worth printing.
 */
export function depinderPreflight(build: boolean): string[] {
    const warnings: string[] = []
    const git = gitInfo(MONOREPO_DIR)
    if (git.branch !== EXPECTED_BRANCH) warnings.push(`depinder is on ${git.branch}, not ${EXPECTED_BRANCH}`)
    if (build) {
        console.log(`Building depinder (${BUILD_COMMAND.join(' ')} in ${MONOREPO_DIR})`)
        sh(BUILD_COMMAND, MONOREPO_DIR, 10 * 60_000)
    }
    const howToBuild = `run ${BUILD_COMMAND.join(' ')} in ${MONOREPO_DIR}, or pass --build-depinder`
    const entry = path.join(DEPINDER_CLI_DIR, 'dist', 'index.js')
    if (!existsSync(entry)) throw new Error(`${entry} is missing: ${howToBuild}`)
    const src = newestMtime(path.join(DEPINDER_CLI_DIR, 'src'))
    const dist = statSync(entry).mtimeMs
    if (src > dist) {
        throw new Error(`depinder dist/ (${new Date(dist).toISOString()}) is older than its src/ (${new Date(src).toISOString()}): ${howToBuild}`)
    }
    for (const producer of ['trivy', 'syft']) {
        if (!existsSync(path.join(INPUT_DIR, producer))) warnings.push(`input folder ${path.join(INPUT_DIR, producer)} is missing`)
    }
    return warnings
}

export interface RunSpec {
    producer: string
    url: string
    token: string
    outDir: string
    logFile: string
    cacheDb: string
    /** Start from an empty SQLite cache (deletes the file and its WAL sidecars). */
    freshCache: boolean
    /** depinder's working directory; nothing should land there, but if it does it stays in the run. */
    cwd: string
    /** Killed after this long; the run then counts as failed (code null). */
    timeoutMs: number
    /** false: `--no-resolver`, so depinder fetches every package itself; the vuln server is still asked. */
    resolver: boolean
    /** ISO date depinder measures ages from (`DEPINDER_REPORT_NOW`), the same for every run of a bench. */
    reportNow: string
}

export interface RunResult {
    start: Date
    end: Date
    wall: number
    code: number | null
    timedOut: boolean
    loadBefore: number[]
    loadAfter: number[]
    strippedEnv: string[]
    profile: Profile | null
    picks: Picks
}

/** A run's SQLite cache with its WAL sidecars copied to a new file, so the original stays as that run left it. */
export function copyCache(from: string, to: string): void {
    if (!existsSync(from)) throw new Error(`cache to copy is missing: ${from}`)
    for (const suffix of ['', '-wal', '-shm']) {
        rmSync(to + suffix, {force: true})
        if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix)
    }
}

/** One `depinder analyse`, stdout and stderr to the log file (a full run outgrows any pipe buffer). */
export async function runDepinder(spec: RunSpec): Promise<RunResult> {
    rmSync(spec.outDir, {recursive: true, force: true})
    mkdirSync(spec.outDir, {recursive: true})
    mkdirSync(path.dirname(spec.logFile), {recursive: true})
    mkdirSync(path.dirname(spec.cacheDb), {recursive: true})
    if (spec.freshCache) {
        for (const suffix of ['', '-wal', '-shm']) rmSync(spec.cacheDb + suffix, {force: true})
    } else if (!existsSync(spec.cacheDb)) {
        throw new Error(`cache to reuse is missing: ${spec.cacheDb}`)
    }
    const {env, stripped} = childEnv(spec.token, spec.cacheDb)
    env.DEPINDER_REPORT_NOW = spec.reportNow
    const args = [
        path.join(DEPINDER_CLI_DIR, 'dist', 'index.js'),
        'analyse', path.join(INPUT_DIR, spec.producer),
        '-r', spec.outDir,
        '--profile',
        '--resolver-url', spec.url,
        ...(spec.resolver ? [] : ['--no-resolver', '--vuln-server']),
    ]
    const log = openSync(spec.logFile, 'w')
    const loadBefore = os.loadavg()
    const start = new Date()
    let timedOut = false
    const code = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, args, {cwd: spec.cwd, stdio: ['ignore', log, log], env})
        // A heartbeat, so a long run is visibly alive in the bench's own output.
        const beat = setInterval(() => {
            const s = Math.round((Date.now() - start.getTime()) / 1000)
            console.log(`    ... ${s} s, log ${Math.round(statSync(spec.logFile).size / 1024)} KiB`)
        }, 60_000)
        const kill = setTimeout(() => {
            timedOut = true
            console.log(`    depinder still running after ${spec.timeoutMs / 60_000} min: killing it`)
            child.kill('SIGKILL')
        }, spec.timeoutMs)
        const done = () => { clearInterval(beat); clearTimeout(kill) }
        child.on('error', e => { done(); reject(e) })
        child.on('exit', c => { done(); resolve(c) })
    }).finally(() => closeSync(log))
    const end = new Date()
    const wall = (end.getTime() - start.getTime()) / 1000
    const profile = parseProfile(readFileSync(spec.logFile, 'utf8'))
    return {start, end, wall, code, timedOut, loadBefore, loadAfter: os.loadavg(), strippedEnv: stripped, profile, picks: pick(profile, wall)}
}
