// The bulk chunks of a real run: sequential, then all of them concurrently. Reports per chunk the
// statuses, when the first line and the trailer arrived, bytes on the wire and decoded, and both
// wall clocks.
//   node --max-old-space-size=12288 --env-file=.env bench/micro/bench-chunks.cjs <purls.json> [mode]
//   mode: seq | conc | both (default both)
const fs = require('node:fs')
const {resolveStream, statusSummary} = require('./bench-stream.cjs')

const [purlFile, mode = 'both'] = process.argv.slice(2)
const purls = JSON.parse(fs.readFileSync(purlFile, 'utf8'))
const CHUNK_SIZE = 2000
const DEADLINE_MS = 15_000

const chunks = []
for (let i = 0; i < purls.length; i += CHUNK_SIZE) chunks.push(purls.slice(i, i + CHUNK_SIZE))

const mb = b => (b / 1048576).toFixed(2)
const ms = v => (v === null ? '-' : v.toFixed(0))
const now = () => Number(process.hrtime.bigint()) / 1e6

/** One chunk, read as a stream: wire bytes, statuses, and when the first line and the trailer came. */
const post = chunk => resolveStream({purls: chunk, deadline_ms: DEADLINE_MS})

const row = (i, r) => ({
    chunk: i + 1,
    purls: chunks[i].length,
    status: r.status,
    'wire MB': mb(r.wireBytes),
    MB: mb(r.bytes),
    statuses: statusSummary(r.statuses),
    'ttfb ms': ms(r.ttfbMs),
    'first line ms': ms(r.firstLineMs),
    'trailer ms': r.trailer ? ms(r.trailerMs) : 'MISSING',
    'total ms': ms(r.totalMs),
    error: r.error ?? '',
})

const totals = rs =>
    `wire ${mb(rs.reduce((a, r) => a + r.wireBytes, 0))} MB   decoded ${mb(rs.reduce((a, r) => a + r.bytes, 0))} MB`

async function main() {
    console.log(`purls ${purls.length} -> ${chunks.length} chunks of <=${CHUNK_SIZE}, deadline_ms ${DEADLINE_MS}`)

    if (mode === 'seq' || mode === 'both') {
        const results = []
        const w0 = now()
        for (let i = 0; i < chunks.length; i++) results.push(await post(chunks[i]))
        const wall = now() - w0
        console.log('--- sequential ---')
        console.table(results.map((r, i) => row(i, r)))
        console.log(`sequential wall clock: ${(wall / 1000).toFixed(2)} s   ${totals(results)}`)
    }

    if (mode === 'conc' || mode === 'both') {
        const w0 = now()
        const results = await Promise.all(chunks.map(c => post(c)))
        const wall = now() - w0
        console.log('--- all chunks concurrent ---')
        console.table(results.map((r, i) => row(i, r)))
        console.log(`concurrent wall clock: ${(wall / 1000).toFixed(2)} s   ${totals(results)}`)
    }
}

main().catch(e => {
    console.error(`failed: ${e.message}`)
    process.exitCode = 1
})
