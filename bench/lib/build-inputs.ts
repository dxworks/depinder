import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import path from 'node:path'
import {MONOREPO_DIR} from './targets.js'

/**
 * What the two benched artefacts are built from, as paths relative to the monorepo, so the bench can
 * tell when one is older than its inputs. Both contain depinder-core.
 */

/** What esbuild bundles into the CLI's dist/: its sources and core's (third-party modules stay external). */
export const CLI_BUNDLE_INPUTS: readonly string[] = [
    'tsconfig.base.json',
    'packages/depinder-cli/src',
    'packages/depinder-cli/esbuild.config.cjs',
    'packages/depinder-cli/tsconfig.json',
    'packages/depinder-cli/tsconfig.build.json',
    'packages/depinder-core/src',
    'packages/depinder-core/tsconfig.json',
    'packages/depinder-core/tsconfig.build.json',
]

/**
 * The server image's inputs: the Dockerfile and what the root .dockerignore lets into the build
 * context (its `!path` lines), read from the file so the two cannot drift apart.
 */
export function serverImageInputs(root = MONOREPO_DIR): string[] {
    const allowed = readFileSync(path.join(root, '.dockerignore'), 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('!'))
        .map(line => line.slice(1).replace(/\/$/, ''))
    return ['packages/depinder-server/Dockerfile', ...allowed]
}

export interface NewestFile {
    /** Relative to the root the inputs were given against. */
    path: string
    mtimeMs: number
}

/** The most recently modified file among `inputs` (files or folders under `root`); null when none exists. */
export function newestFile(inputs: readonly string[], root = MONOREPO_DIR): NewestFile | null {
    let newest: NewestFile | null = null
    for (const file of inputs.flatMap(input => filesAt(path.join(root, input)))) {
        const mtimeMs = statSync(file).mtimeMs
        if (!newest || mtimeMs > newest.mtimeMs) newest = {path: path.relative(root, file), mtimeMs}
    }
    return newest
}

/** The file itself, every file under a folder, or nothing when the path does not exist. */
function filesAt(full: string): string[] {
    if (!existsSync(full)) return []
    if (!statSync(full).isDirectory()) return [full]
    return readdirSync(full, {withFileTypes: true, recursive: true})
        .filter(entry => entry.isFile())
        .map(entry => path.join(entry.parentPath, entry.name))
}
