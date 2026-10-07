// Fails when a measured file is over its size limit or a baseline file grew. Usage: node size-guard.mts
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {checkSizes, classify, countLines, type Baseline} from './size-limits.mts'

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding: 'utf8'}).trim()
const baselineFile = path.join(import.meta.dirname, '..', 'size-baseline.json')

/** Tracked and new (not ignored) files, so a file is measured before its first commit. */
function workspaceFiles(): string[] {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {cwd: repoRoot, encoding: 'utf8'})
    return [...new Set(out.split('\0').filter(Boolean))]
}

const lineCounts: Record<string, number> = {}
for (const file of workspaceFiles()) {
    if (!classify(file)) continue
    try {
        lineCounts[file] = countLines(readFileSync(path.join(repoRoot, file), 'utf8'))
    } catch {
        // deleted in the working tree but not yet staged
    }
}

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline
const {errors, warnings} = checkSizes(lineCounts, baseline)
for (const warning of warnings) console.log(`warning  ${warning}`)
for (const error of errors) console.log(`error    ${error}`)
console.log(`size guard: ${Object.keys(lineCounts).length} files measured, ${errors.length} errors, ${warnings.length} warnings`)
process.exitCode = errors.length > 0 ? 1 : 0
