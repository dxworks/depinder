import path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Where the bench points: which stack, which database, and how to stop and start its resolver.
 *
 * The three targets differ in how much damage a wipe can do. `dev` is the scratch database in
 * `.env`; `deploy` and `hosted` are the database the deployed server uses (deploy/.depinder.server.env),
 * so wiping them needs an extra flag on top of the confirmation.
 */

/** depinder-server-side, the folder this bench lives in. */
export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** The workspace holding depinder, depinder-server-side and input_data side by side. */
export const WORKSPACE_DIR = path.resolve(REPO_DIR, '..')
export const DEPINDER_DIR = process.env.BENCH_DEPINDER_DIR ?? path.join(WORKSPACE_DIR, 'depinder')
export const INPUT_DIR = process.env.BENCH_INPUT_DIR
    ?? path.join(WORKSPACE_DIR, 'input_data', 'zzw-v051-rerun', 'depminer', 'results')
export const RUNS_DIR = path.join(REPO_DIR, 'bench', 'runs')

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
const DEPLOY_ENV = path.join(REPO_DIR, 'deploy', '.depinder.server.env')

/** Builds a target; `hosted` needs BENCH_URL. Throws with a message for the person running it. */
export function resolveTarget(name: string): Target {
    if (name === 'dev' || name === 'deploy') {
        // `-f docker-compose.yml` always, so a stray docker-compose.override.yml is never picked up.
        const composeFiles = name === 'dev'
            ? ['-f', 'docker-compose.yml']
            : ['-f', 'docker-compose.yml', '-f', path.join('bench', 'compose.deploy-db.yml')]
        return {
            name,
            url: 'http://localhost:8080',
            envFile: name === 'dev' ? path.join(REPO_DIR, '.env') : DEPLOY_ENV,
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
