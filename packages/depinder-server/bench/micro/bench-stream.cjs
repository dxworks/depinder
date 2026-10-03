// One POST /resolve read as the stream it is, for the bench scripts.
//
// Not through fetch: fetch decodes the body before handing it over, so the bytes it reports are
// the decoded ones. This reads the socket itself, counts what crossed the wire, decodes br or gzip
// as it arrives, and times the first line and the trailer. It asks for `br, gzip`, as depinder does.
const http = require('node:http')
const zlib = require('node:zlib')

const TARGET = new URL(process.env.RESOLVER_URL ?? 'http://localhost:8080/resolve')

/**
 * Resolves with {status, encoding, requestBytes, wireBytes, bytes, ttfbMs, firstLineMs, trailerMs,
 * totalMs, statuses, items, trailer, text, error}. `trailer` false means the stream was cut short.
 * `text` (the decoded NDJSON) is kept only when `keepText` is set.
 */
function resolveStream(payload, {keepText = false} = {}) {
    const body = JSON.stringify(payload)
    const now = () => Number(process.hrtime.bigint()) / 1e6
    const t0 = now()
    const result = {
        status: 0,
        encoding: '(none)',
        requestBytes: Buffer.byteLength(body),
        wireBytes: 0,
        bytes: 0,
        ttfbMs: null,
        firstLineMs: null,
        trailerMs: null,
        totalMs: null,
        statuses: {},
        items: 0,
        trailer: false,
        text: keepText ? '' : undefined,
        error: null,
    }
    return new Promise(resolve => {
        const done = error => {
            if (result.totalMs !== null) return
            result.totalMs = now() - t0
            result.error = error ? error.message : null
            resolve(result)
        }
        const request = http.request(TARGET, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${process.env.RESOLVER_API_TOKEN}`,
                'content-type': 'application/json',
                'content-length': result.requestBytes,
                'accept-encoding': 'br, gzip',
            },
        }, response => {
            result.ttfbMs = now() - t0
            result.status = response.statusCode
            result.encoding = response.headers['content-encoding'] ?? '(none)'
            response.on('data', chunk => (result.wireBytes += chunk.length))
            const decoded = result.encoding === 'br'
                ? response.pipe(zlib.createBrotliDecompress())
                : result.encoding === 'gzip'
                  ? response.pipe(zlib.createGunzip())
                  : response
            let pending = ''
            decoded.setEncoding('utf8')
            decoded.on('data', text => {
                result.bytes += Buffer.byteLength(text)
                if (keepText) result.text += text
                pending += text
                let nl
                while ((nl = pending.indexOf('\n')) >= 0) {
                    const line = pending.slice(0, nl)
                    pending = pending.slice(nl + 1)
                    if (!line) continue
                    if (result.firstLineMs === null) result.firstLineMs = now() - t0
                    let parsed
                    try {
                        parsed = JSON.parse(line)
                    } catch {
                        continue
                    }
                    if (parsed.done === true) {
                        result.trailer = true
                        result.trailerMs = now() - t0
                    } else if (parsed.status) {
                        result.items++
                        result.statuses[parsed.status] = (result.statuses[parsed.status] ?? 0) + 1
                    }
                }
            })
            decoded.on('end', () => done(null))
            decoded.on('error', done)
            response.on('error', done)
        })
        request.on('error', done)
        request.end(body)
    })
}

/** `resolved 1900 · pending 100`, in a fixed order. */
function statusSummary(statuses) {
    const order = ['resolved', 'refreshing', 'pending', 'not_found', 'error', 'invalid']
    return order.filter(s => statuses[s]).map(s => `${s} ${statuses[s]}`).join(' · ') || '-'
}

module.exports = {resolveStream, statusSummary}
