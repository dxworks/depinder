// Polls until nothing is pending, so source edits (which restart tsx watch) can wait for the
// demand-fill to drain.
//   node --env-file=.env scripts/ops/wait-for-fill.cjs   (from the repo root)
const {Pool} = require('pg')

const POLL_MS = 15_000
const pool = new Pool({connectionString: process.env.DATABASE_URL, ssl: {rejectUnauthorized: false}})

const SQL = `select
    count(*) filter (where status = 'pending')  as pending,
    count(*) filter (where status = 'resolved') as resolved,
    (select count(*) from fetch_queue)          as queued
  from package`

let last = null
let lastAt = Date.now()

async function poll() {
    let rows
    try {
        ({rows} = await pool.query(SQL))
    } catch (e) {
        // The worker can saturate the session pooler; losing a sample is fine, retry later.
        console.log(`${new Date().toISOString().slice(11, 19)}  (no connection: ${e.message.slice(0, 60)})`)
        setTimeout(() => void poll().catch(fail), POLL_MS)
        return
    }
    const [row] = rows
    const pending = Number(row.pending)
    const now = Date.now()
    // Rate is what matters here: it is the number the batch ceiling caps.
    const rate = last === null ? null : ((last - pending) / ((now - lastAt) / 1000)).toFixed(1)
    console.log(`${new Date().toISOString().slice(11, 19)}  pending=${pending}  resolved=${row.resolved}  queued=${row.queued}${rate === null ? '' : `  (${rate}/s)`}`)
    last = pending
    lastAt = now

    if (pending === 0) {
        console.log('FILL COMPLETE')
        await pool.end()
        return
    }
    setTimeout(() => void poll().catch(fail), POLL_MS)
}

function fail(e) {
    console.error(`wait failed: ${e.message}`)
    process.exitCode = 1
    void pool.end()
}

poll().catch(fail)
