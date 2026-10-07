import {createInterface} from 'node:readline/promises'
import {counts, formatCounts, truncateAll, type BenchDb} from './db.js'
import {resolverStart, resolverStop, waitHealthy} from './stack.js'
import type {Target} from './targets.js'

/**
 * Emptying the resolver's database, shared by `run.ts` (the empty cell) and `reset.ts`.
 *
 * Two locks: a typed confirmation (skipped by --yes) on every target, and --allow-wipe-nondev on
 * the targets whose database is the deployed server's. --yes alone never wipes deploy or hosted.
 */

export interface WipeGuard {
    yes: boolean
    allowNonDev: boolean
}

/** Throws unless this target may be wiped with these flags. Call before any work starts. */
export function checkWipeAllowed(target: Target, guard: WipeGuard): void {
    if (target.guarded && !guard.allowNonDev) {
        throw new Error(`--target ${target.name} uses the deployed server's database; wiping it needs --allow-wipe-nondev`)
    }
    if (!guard.yes && !process.stdin.isTTY) {
        // Checked up front, before the stack is touched: nobody is there to type the confirmation.
        throw new Error('a wipe needs a typed confirmation, but stdin is not a terminal: pass --yes')
    }
}

/**
 * Shows what would be lost and asks for `wipe` on stdin, unless --yes. Returns false when the
 * answer was anything else.
 */
export async function confirmWipe(target: Target, host: string, db: BenchDb, guard: WipeGuard, what: string): Promise<boolean> {
    console.log(`\nThe ${host} holds: ${formatCounts(await counts(db))}`)
    console.log(`${what} will TRUNCATE package, package_version, fetch_queue, fetch_log and registry_feed there.`)
    if (guard.yes) {
        console.log('--yes given: not asking.')
        return true
    }
    if (!process.stdin.isTTY) {
        // Under nohup, a CI job or a background shell nobody can answer; waiting would hang forever.
        console.log('stdin is not a terminal and --yes was not given: not asking, not wiping.')
        return false
    }
    const rl = createInterface({input: process.stdin, output: process.stdout})
    try {
        const answer = await rl.question('Type "wipe" to go on: ')
        return answer.trim() === 'wipe'
    } finally {
        rl.close()
    }
}

/**
 * Stop the resolver, truncate, check every count is 0, start it, wait until healthy. The restart is
 * part of the wipe, not a convenience: the API keeps version tuples in memory, and a resolver that
 * kept running would answer from that cache for packages the database no longer has.
 */
export async function wipe(target: Target, host: string, db: BenchDb): Promise<void> {
    console.log(`Stopping the resolver (${target.stopResolver.join(' ')})`)
    resolverStop(target)
    try {
        await truncateAll(db)
        const after = await counts(db)
        console.log(`Wiped the ${host}: ${formatCounts(after)}`)
        if (after.packages || after.versions || after.queued || after.fetchLog) {
            throw new Error('rows left after the truncate: something else writes to this database')
        }
    } finally {
        console.log(`Starting the resolver (${target.startResolver.join(' ')})`)
        resolverStart(target)
    }
    await waitHealthy(target)
    console.log('Resolver healthy again.')
}
