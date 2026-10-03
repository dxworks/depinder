// How POST /vulnerabilities holds up under parallel chunks: Phase 0's 10,049 purls, split into k
// chunks sent all at once, for k = 1, 2, 3, 5, 10, three times each. Re-run on the deploy machine
// to choose VULN_MAX_SCANS: the best k there is about the scans it can run at once.
//   VULN_URL=http://localhost:8081 RESOLVER_API_TOKEN=... P0=<phase 0 folder> node bench/micro/vuln-bench.cjs
// k = 1 and 2 send more than 5,000 purls in one request, so start the server with
// VULN_MAX_PURLS=20000 or they come back 413. The queue time is the server's, from Server-Timing.
const fs = require('node:fs')
const path = require('node:path')

const url = new URL('/vulnerabilities', process.env.VULN_URL || 'http://localhost:8080')
const token = process.env.RESOLVER_API_TOKEN || ''
const p0 = process.env.P0
if (!p0 || !token) {
    console.error('set P0 (the phase 0 folder) and RESOLVER_API_TOKEN; VULN_URL defaults to http://localhost:8080')
    process.exit(2)
}

const KS = [1, 2, 3, 5, 10]
const REPEATS = 3

const purls = fs.readFileSync(path.join(p0, 'purls.txt'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean)

function split(list, k) {
    const size = Math.ceil(list.length / k)
    return Array.from({length: k}, (_, i) => list.slice(i * size, (i + 1) * size)).filter(c => c.length > 0)
}

/** `queue;dur=12, trivy;dur=...` -> {queue: 12, ...} */
function timing(header) {
    const out = {}
    for (const part of (header || '').split(',')) {
        const m = /^\s*(\w+);dur=([\d.]+)/.exec(part)
        if (m) out[m[1]] = Number(m[2])
    }
    return out
}

async function post(chunk) {
    const res = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'accept-encoding': 'br, gzip'},
        body: JSON.stringify({purls: chunk}),
    })
    await res.arrayBuffer()
    return {status: res.status, timing: timing(res.headers.get('server-timing'))}
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function main() {
    console.log(`${purls.length} purls -> ${url}`)
    const rows = []
    for (const k of KS) {
        const walls = []
        let busy = 0
        let other = 0
        let maxQueue = 0
        for (let r = 0; r < REPEATS; r++) {
            const started = Date.now()
            const results = await Promise.all(split(purls, k).map(post))
            walls.push((Date.now() - started) / 1000)
            for (const result of results) {
                if (result.status === 503) busy++
                else if (result.status !== 200) other++
                maxQueue = Math.max(maxQueue, result.timing.queue || 0)
            }
        }
        rows.push({
            k,
            'purls/chunk': Math.ceil(purls.length / k),
            'median wall s': median(walls).toFixed(2),
            '503 busy': busy,
            'other non-200': other,
            'max queue ms': maxQueue,
        })
    }
    console.table(rows)
}

main().catch(e => {
    console.error(`failed: ${e.message}`)
    process.exitCode = 1
})
