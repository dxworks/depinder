import path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Where the bench points: which stack, which database, and how to stop and start its resolver.
 *
 * The three targets differ in how much damage a wipe can do. `dev` is the scratch database in the
 * server's `.env`; `deploy` and `hosted` are the database the deployed server uses
 * (deploy/.depinder.server.env), so wiping them needs an extra flag on top of the confirmation.
 */

/** The depinder monorepo: this bench, the CLI and the server. */
export const MONOREPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** The server's project: its compose stack, env files and source. */
export const SERVER_DIR = path.join(MONOREPO_DIR, 'packages', 'depinder-server')
/** The folder holding the monorepo and input_data side by side. */
export const WORKSPACE_DIR = path.resolve(MONOREPO_DIR, '..')
export const INPUT_DIR = process.env.BENCH_INPUT_DIR
    ?? path.join(WORKSPACE_DIR, 'input_data', 'zzw-v051-rerun', 'depminer', 'results')
export const RUNS_DIR = path.join(MONOREPO_DIR, 'bench', 'runs')
const DEPLOY_DB_OVERRIDE = path.join(MONOREPO_DIR, 'bench', 'compose.deploy-db.yml')

export type TargetName = 'dev' | 'deploy' | 'hosted'
export const TARGET_NAMES: readonly TargetName[] = ['dev', 'deploy', 'hosted']

export interface Target {
    name: TargetName
    url: string
    envFile: string
    /** compose reads the deploy env file with `format: raw`; the bench must read it the same way. */
    envRaw: boolean
    /** `-f` arguments for `docker compose`, or null when the stack is not local (hosted). */
    composeFiles: string[] | null
    /** A wipe here needs --allow-wipe-nondev as well as the confirmation. */
    guarded: boolean
    /** The commands that stop and start the resolver container, as argv. */
    stopResolver: string[]
    startResolver: string[]
}

const SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'depinder']
const DEPLOY_ENV = path.join(SERVER_DIR, 'deploy', '.depinder.server.env')

/** Builds a target; `hosted` needs BENCH_URL. Throws with a message for the person running it. */
export function resolveTarget(name: string): Target {
    if (name === 'dev' || name === 'deploy') {
        // Run in SERVER_DIR; `-f docker-compose.yml` always, so a stray override file is never picked up.
        const composeFiles = name === 'dev'
            ? ['-f', 'docker-compose.yml']
            : ['-f', 'docker-compose.yml', '-f', DEPLOY_DB_OVERRIDE]
        return {
            name,
            url: 'http://localhost:8080',
            envFile: name === 'dev' ? path.join(SERVER_DIR, '.env') : DEPLOY_ENV,
            envRaw: name === 'deploy',
            composeFiles,
            guarded: name === 'deploy',
            stopResolver: ['docker', 'compose', ...composeFiles, 'stop', 'resolver'],
            startResolver: ['docker', 'compose', ...composeFiles, 'start', 'resolver'],
        }
    }
    if (name === 'hosted') {
        const url = process.env.BENCH_URL
        if (!url) throw new Error('--target hosted needs BENCH_URL (e.g. BENCH_URL=http://<server ip>)')
        return {
            name,
            url: url.replace(/\/+$/, ''),
            envFile: DEPLOY_ENV,
            envRaw: true,
            composeFiles: null,
            guarded: true,
            // `depinder` on the server is the compose shortcut 07-upload.sh installs (deploy/README.md).
            // BatchMode: a key that needs a passphrase fails at once instead of prompting.
            stopResolver: [...SSH, 'depinder', 'stop', 'resolver'],
            startResolver: [...SSH, 'depinder', 'start', 'resolver'],
        }
    }
    throw new Error(`unknown --target "${name}" (one of ${TARGET_NAMES.join(', ')})`)
}
