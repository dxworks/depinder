// Checks POST /vulnerabilities against Phase 0: the server's findings for Phase 0's 10,049 purls
// must be exactly the findings Phase 0 got by scanning them itself, with the same scanners and the
// same frozen databases.
//   VULN_URL=http://localhost:8081 RESOLVER_API_TOKEN=... P0=<phase 0 folder> npx tsx bench/micro/vuln-parity.ts
// The server must run with P0's databases: TRIVY_CACHE_DIR=$P0/db/trivy GRYPE_DB_CACHE_DIR=$P0/db/grype.
//
// $P0/t-all.json and $P0/g-all.json are Trivy's and Grype's raw output for all of $P0/purls.txt in
// one SBOM whose bom-refs were the purls themselves, so the identity map is their ref map.
//
// 1. every key of every answer is a purl that was sent in that chunk
// 2. Trivy: every (BOMRef, VulnerabilityID) of t-all.json is a finding with source trivy for that
//    purl, and every finding with source trivy is one of them
// 3. Grype: the same for (artifact.purl, vulnerability.id) of g-all.json
// 4. the whole `vulnerabilities` map deep-equals the same merge run here over t-all and g-all,
//    which compares every field: severity, fixes, CVSS, range, references
// 5. prints the answer's size raw, gzip and br for 2,000 and 5,000 purls
// Exits 1 on any difference, printing the first 20.
import {readFileSync} from 'node:fs'
import {request} from 'node:http'
import {join} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {buildVulnerabilityIndex, type GrypeReport, type TrivyReport, type Vulnerability} from '../../src/vuln/merge/index.js'

const url = new URL('/vulnerabilities', process.env.VULN_URL ?? 'http://localhost:8080')
const token = process.env.RESOLVER_API_TOKEN ?? ''
const p0 = process.env.P0
if (!p0 || !token) {
    console.error('set P0 (the phase 0 folder) and RESOLVER_API_TOKEN; VULN_URL defaults to http://localhost:8080')
    process.exit(2)
}

const CHUNK = 2000
const AT_ONCE = 5

type Answer = {vulnerabilities: Record<string, Vulnerability[]>, unsupported: {purl: string, reason: string}[]}

/** One POST, the body counted as it came over the wire and returned decoded only for identity. */
function post(purls: string[], encoding = 'identity'): Promise<{status: number, bytes: number, text: string}> {
    const body = JSON.stringify({purls})
    return new Promise((resolve, reject) => {
        const req = request(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
                authorization: `Bearer ${token}`,
                'accept-encoding': encoding,
            },
        }, res => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
                const raw = Buffer.concat(chunks)
                resolve({status: res.statusCode ?? 0, bytes: raw.length, text: encoding === 'identity' ? raw.toString('utf8') : ''})
            })
            res.on('error', reject)
        })
        req.on('error', reject)
        req.end(body)
    })
}

const differences: string[] = []
const differ = (line: string): void => {
    differences.push(line)
}

async function main(): Promise<void> {
    const purls = readFileSync(join(p0!, 'purls.txt'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean)
    const trivy = JSON.parse(readFileSync(join(p0!, 't-all.json'), 'utf8')) as TrivyReport
    const grype = JSON.parse(readFileSync(join(p0!, 'g-all.json'), 'utf8')) as GrypeReport

    // 1. Chunks of 2,000, five at once.
    const chunks: string[][] = []
    for (let i = 0; i < purls.length; i += CHUNK) chunks.push(purls.slice(i, i + CHUNK))
    const answers: Answer[] = new Array(chunks.length)
    let next = 0
    const started = Date.now()
    await Promise.all(Array.from({length: AT_ONCE}, async () => {
        while (next < chunks.length) {
            const i = next++
            const response = await post(chunks[i]!)
            if (response.status !== 200) throw new Error(`chunk ${i}: HTTP ${response.status} ${response.text.slice(0, 300)}`)
            answers[i] = JSON.parse(response.text) as Answer
        }
    }))
    console.log(`${purls.length} purls in ${chunks.length} chunks of ${CHUNK}, ${AT_ONCE} at once: ${((Date.now() - started) / 1000).toFixed(2)} s`)

    const server: Record<string, Vulnerability[]> = {}
    answers.forEach((answer, i) => {
        const sent = new Set(chunks[i])
        for (const [purl, findings] of Object.entries(answer.vulnerabilities)) {
            if (!sent.has(purl)) differ(`chunk ${i}: key not sent: ${purl}`)
            server[purl] = findings
        }
        for (const item of answer.unsupported) differ(`chunk ${i}: unsupported ${item.purl} (${item.reason})`)
    })

    // 2 and 3. Each tool's (purl, id) pairs.
    const trivyPairs = new Set<string>()
    for (const result of trivy.Results ?? []) {
        for (const v of result.Vulnerabilities ?? []) trivyPairs.add(`${v.PkgIdentifier?.BOMRef}|${v.VulnerabilityID}`)
    }
    const grypePairs = new Set<string>()
    for (const m of grype.matches ?? []) grypePairs.add(`${m.artifact?.purl}|${m.vulnerability?.id}`)
    const trivyFound = comparePairs('trivy', trivyPairs, server)
    const grypeFound = comparePairs('grype', grypePairs, server)
    console.log(`trivy pairs: ${trivyFound} / ${trivyPairs.size}`)
    console.log(`grype pairs: ${grypeFound} / ${grypePairs.size}`)

    // 4. Every field, against the same merge run here.
    const identity = new Map(purls.map(p => [p, p]))
    const local = JSON.parse(JSON.stringify(Object.fromEntries(buildVulnerabilityIndex(trivy, grype, identity).index))) as Record<string, Vulnerability[]>
    let unequal = 0
    for (const purl of new Set([...Object.keys(local), ...Object.keys(server)])) {
        if (!isDeepStrictEqual(local[purl], server[purl])) {
            unequal++
            differ(`not equal: ${purl}\n  local  ${JSON.stringify(local[purl])?.slice(0, 400)}\n  server ${JSON.stringify(server[purl])?.slice(0, 400)}`)
        }
    }
    console.log(`full map: ${Object.keys(server).length} vulnerable purls on the server, ${Object.keys(local).length} locally, ${unequal} unequal`)

    // 5. Payload sizes.
    for (const n of [2000, 5000]) {
        const sizes: string[] = []
        for (const encoding of ['identity', 'gzip', 'br']) {
            const response = await post(purls.slice(0, n), encoding)
            if (response.status !== 200) differ(`size check ${n} ${encoding}: HTTP ${response.status}`)
            sizes.push(`${encoding === 'identity' ? 'raw' : encoding} ${(response.bytes / 1024).toFixed(0)} KB`)
        }
        console.log(`answer for ${n} purls: ${sizes.join(', ')}`)
    }

    if (differences.length > 0) {
        console.log(`\n${differences.length} difference(s); the first 20:`)
        for (const line of differences.slice(0, 20)) console.log(`  ${line}`)
        process.exitCode = 1
    } else {
        console.log('\nOK: the server answers exactly what Phase 0 found')
    }
}

/**
 * How many of a tool's pairs the server has as a finding with that tool in `source` and that id in
 * `identifiers`; and, the other way, any such finding that matches none of the tool's pairs.
 */
function comparePairs(tool: string, pairs: Set<string>, server: Record<string, Vulnerability[]>): number {
    let found = 0
    for (const pair of pairs) {
        const at = pair.lastIndexOf('|')
        const [purl, id] = [pair.slice(0, at), pair.slice(at + 1)]
        const hit = (server[purl] ?? []).some(f => f.source?.split(',').includes(tool) && f.identifiers?.some(i => i.value === id))
        if (hit) found++
        else differ(`${tool}: missing ${purl} ${id}`)
    }
    for (const [purl, findings] of Object.entries(server)) {
        for (const f of findings) {
            if (!f.source?.split(',').includes(tool)) continue
            if (!f.identifiers?.some(i => pairs.has(`${purl}|${i.value}`))) {
                differ(`${tool}: extra ${purl} ${f.identifiers?.map(i => i.value).join(',')}`)
            }
        }
    }
    return found
}

main().catch(e => {
    console.error(`failed: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
})
