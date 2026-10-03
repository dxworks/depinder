import {parseArgs} from 'node:util'
import {openDb} from './lib/db.js'
import {maskedDbHost, readEnvFile} from './lib/env.js'
import {resolveTarget} from './lib/targets.js'
import {checkWipeAllowed, confirmWipe, wipe} from './lib/wipe.js'

/**
 * Empties the resolver's database on its own, with the bench's locks: a typed confirmation unless
 * --yes, and --allow-wipe-nondev for deploy and hosted. Stops the resolver for the truncate and
 * starts it again, so its in-memory version cache goes with the rows.
 *
 *   npm run bench:reset -- --target dev|deploy|hosted [--yes] [--allow-wipe-nondev]
 */

async function main(): Promise<void> {
    const {values} = parseArgs({options: {
        'target': {type: 'string'},
        'yes': {type: 'boolean', default: false},
        'allow-wipe-nondev': {type: 'boolean', default: false},
    }})
    // No default target: a reset is the one command where typing the database's name is the point.
    if (!values.target) throw new Error('usage: npm run bench:reset -- --target dev|deploy|hosted [--yes] [--allow-wipe-nondev]')
    const target = resolveTarget(values.target)
    const guard = {yes: values.yes, allowNonDev: values['allow-wipe-nondev']}
    checkWipeAllowed(target, guard)
    const env = readEnvFile(target.envFile, target.envRaw)
    const host = maskedDbHost(target.name, env.DATABASE_URL)
    const db = openDb(env)
    try {
        if (!await confirmWipe(target, host, db, guard, 'This reset')) {
            console.log('Not confirmed; nothing was changed.')
            process.exitCode = 1
            return
        }
        await wipe(target, host, db)
    } finally {
        await db.end()
    }
}

main().catch(e => {
    console.error(`reset failed: ${(e as Error).message}`)
    process.exitCode = 1
})
