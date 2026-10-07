// Keeps POST /vulnerabilities busy while the server switches databases, and shows that nobody
// noticed: chunks of 2,000 of Phase 0's purls, SOAK_CONCURRENCY at a time, for SOAK_SECONDS.
//   VULN_URL=http://localhost:8081 RESOLVER_API_TOKEN=... P0=<phase 0 folder> node bench/micro/vuln-soak.cjs
// Prints every build the answers name the first time it appears (`databases.trivy.built_at`,
// `databases.grype.built_at`), progress every 30 s, and at the end each build's first and last
// answer and every non-200. Exits 1 if there was any non-200.
const fs = require('node:fs')
const path = require('node:path')

const url = new URL('/vulnerabilities', process.env.VULN_URL || 'http://localhost:8080')
const token = process.env.RESOLVER_API_TOKEN || ''
const p0 = process.env.P0
if (!p0 || !token) {
    console.error('set P0 (the phase 0 folder) and RESOLVER_API_TOKEN; VULN_URL defaults to http://localhost:8080')
    process.exit(2)
}
const seconds = Number(process.env.SOAK_SECONDS || 600)
const concurrency = Number(process.env.SOAK_CONCURRENCY || 2)
const CHUNK = 2000

const purls = fs.readFileSync(path.join(p0, 'purls.txt'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
const chunks = []
for (let i = 0; i + CHUNK <= purls.length; i += CHUNK) chunks.push(purls.slice(i, i + CHUNK))

const stamp = () => new Date().toISOString()
let sent = 0
let ok = 0
const failures = []
/** tool -> built_at -> {first, last, answers} */
const builds = {trivy: new Map(), grype: new Map()}
const ms = []

function note(tool, build) {
    const seen = builds[tool].get(build.built_at)
    const now = stamp()
    if (seen) {
        seen.last = now
        seen.answers++
        return
    }
    builds[tool].set(build.built_at, {first: now, last: now, answers: 1})
    const before = builds[tool].size === 1 ? 'first answer' : `was ${[...builds[tool].keys()].slice(-2, -1)[0]}`
    console.log(`${now}  ${tool} build ${build.built_at} (${before}; request #${sent})`)
}

async function post(chunk) {
    const started = Date.now()
    const res = await fetch(url, {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: `Bearer ${token}`, 'accept-encoding': 'br, gzip'},
        body: JSON.stringify({purls: chunk}),
    })
    const text = await res.text()
    ms.push(Date.now() - started)
    if (res.status !== 200) {
        failures.push({at: stamp(), status: res.status, body: text.slice(0, 200)})
        console.log(`${stamp()}  HTTP ${res.status} ${text.slice(0, 200)}`)
        return
    }
    ok++
    const body = JSON.parse(text)
    note('trivy', body.databases.trivy)
    note('grype', body.databases.grype)
}

async function main() {
    console.log(`${stamp()}  ${concurrency} at a time, ${CHUNK} purls each, for ${seconds} s -> ${url}`)
    const end = Date.now() + seconds * 1000
    const progress = setInterval(() => console.log(`${stamp()}  ${sent} sent, ${ok} ok, ${failures.length} non-200`), 30_000)
    await Promise.all(Array.from({length: concurrency}, async (_, worker) => {
        let next = worker
        while (Date.now() < end) {
            sent++
            try {
                await post(chunks[next++ % chunks.length])
            } catch (e) {
                failures.push({at: stamp(), status: 'error', body: e.cause?.code || e.message})
                console.log(`${stamp()}  request failed: ${e.cause?.code || e.message}`)
            }
        }
    }))
    clearInterval(progress)

    const sorted = [...ms].sort((a, b) => a - b)
    console.log(`\n${sent} requests, ${ok} ok, ${failures.length} non-200; `
        + `median ${sorted[Math.floor(sorted.length / 2)]} ms, max ${sorted[sorted.length - 1]} ms`)
    for (const tool of ['trivy', 'grype']) {
        for (const [builtAt, seen] of builds[tool]) {
            console.log(`  ${tool} ${builtAt}: ${seen.answers} answers, first ${seen.first}, last ${seen.last}`)
        }
    }
    for (const f of failures.slice(0, 20)) console.log(`  ${f.at} ${f.status} ${f.body}`)
    if (failures.length > 0) process.exitCode = 1
}

main().catch(e => {
    console.error(`failed: ${e.message}`)
    process.exitCode = 1
})
