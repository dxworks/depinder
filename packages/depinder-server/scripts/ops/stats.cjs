// Read-only snapshot of the resolver's store. Nothing here writes.
//   node --env-file=.env scripts/ops/stats.cjs   (from the repo root)
const {Pool} = require('pg')

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {rejectUnauthorized: false},
})

const TOTALS = `select
    (select count(*) from package)                          as packages,
    (select count(*) from package where status = 'resolved') as resolved,
    (select count(*) from package where status = 'pending')  as pending,
    (select count(*) from package where status = 'not_found') as not_found,
    (select count(*) from package where status = 'error')     as error,
    (select count(*) from package where tracked)              as tracked,
    (select count(*) from package_version)                    as versions,
    (select count(*) from fetch_queue)                        as queued,
    (select count(*) from fetch_log)                          as http_requests`

const BY_TYPE = `select type, status, count(*)::int as n from package group by type, status order by type, status`

pool.query(TOTALS)
    .then(({rows}) => {
        console.log('--- totals ---')
        console.table(rows)
        return pool.query(BY_TYPE)
    })
    .then(({rows}) => {
        console.log('--- by ecosystem ---')
        console.table(rows)
    })
    .catch(e => {
        console.error(`stats failed: ${e.message}`)
        process.exitCode = 1
    })
    .finally(() => pool.end())
