// Fails when the workspace holds two versions of a dependency. Usage: node dependency-check.mts
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {checkDependencies, type LockPackages, type Manifest} from './dependency-rules.mts'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim()
const readJson = (file: string) => JSON.parse(readFileSync(path.join(repoRoot, file), 'utf8'))

const lock = readJson('package-lock.json')
const lockPackages = lock.packages as LockPackages
// The lockfile lists every workspace project as a linked entry, the root as ''.
const projectLocations = ['', ...Object.entries(lockPackages)
    .filter(([installPath, entry]) => entry.link && installPath.startsWith('node_modules/'))
    .map(([, entry]) => (entry as {resolved?: string}).resolved)
    .filter((location): location is string => Boolean(location))]
const manifests: Manifest[] = projectLocations.map(location => ({location, ...readJson(path.join(location, 'package.json'))}))

const {errors, notes} = checkDependencies(manifests, lockPackages)
for (const note of notes) console.log(`note     ${note}`)
for (const error of errors) console.log(`error    ${error}`)
console.log(`dependency check: ${manifests.length} projects, ${errors.length} errors, ${notes.length} notes`)
process.exitCode = errors.length > 0 ? 1 : 0
