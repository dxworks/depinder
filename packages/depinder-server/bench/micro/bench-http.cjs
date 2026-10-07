// Times ONE POST /resolve end to end from the client's point of view and saves the body.
//   node --env-file=.env bench/micro/bench-http.cjs <purls.json> <out-body.ndjson> [deadline_ms] [repeats]
// Nothing is written to the database beyond what a normal /resolve does (deadline_ms 0, all resolved).
// Asks for `br, gzip` as depinder does; `wire` is the compressed size, `response` the decoded NDJSON.
const fs = require('node:fs')
const {resolveStream, statusSummary} = require('./bench-stream.cjs')

const [purlFile, outFile, deadlineRaw, repeatRaw] = process.argv.slice(2)
const deadlineMs = Number(deadlineRaw ?? 0)
const repeats = Number(repeatRaw ?? 1)
const purls = JSON.parse(fs.readFileSync(purlFile, 'utf8'))

const mb = b => (b / 1024 / 1024).toFixed(2) + ' MB'
const fmt = ms => (ms === null ? '-' : ms.toFixed(1))

async function once(save) {
    const r = await resolveStream({purls, deadline_ms: deadlineMs}, {keepText: save})
    if (save) fs.writeFileSync(outFile, r.text)
    return r
}

async function main() {
    const rows = []
    for (let i = 0; i < repeats; i++) rows.push(await once(i === repeats - 1))
    console.log(`purls ${purls.length}   request body ${mb(rows[0].requestBytes)}   status ${rows[0].status}   content-encoding ${rows[0].encoding}   deadline_ms ${deadlineMs}`)
    console.table(rows.map((r, i) => ({
        run: i + 1,
        wire: mb(r.wireBytes),
        response: mb(r.bytes),
        items: r.items,
        statuses: statusSummary(r.statuses),
        'ttfb ms': fmt(r.ttfbMs),
        'first line ms': fmt(r.firstLineMs),
        'trailer ms': r.trailer ? fmt(r.trailerMs) : 'MISSING',
        'total ms': fmt(r.totalMs),
        error: r.error ?? '',
    })))
    console.log(`saved ${outFile}`)
}

main().catch(e => {
    console.error(`failed: ${e.message}`)
    process.exitCode = 1
})
