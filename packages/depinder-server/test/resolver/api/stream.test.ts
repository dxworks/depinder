import {PassThrough} from 'node:stream'
import {brotliDecompressSync, constants as zlib, gunzipSync} from 'node:zlib'
import {describe, expect, it} from 'vitest'
import {chooseEncoding, createNdjsonWriter, type StreamEncoding} from '../../../src/resolver/api/stream.js'

describe('chooseEncoding', () => {
    it('prefers brotli, then gzip, then nothing', () => {
        expect(chooseEncoding('gzip, deflate, br')).toBe('br')
        expect(chooseEncoding('gzip, deflate')).toBe('gzip')
        expect(chooseEncoding('deflate')).toBe('identity')
        expect(chooseEncoding('')).toBe('identity')
        expect(chooseEncoding(undefined)).toBe('identity')
    })

    it('honours q=0 as a refusal, and * as anything not named', () => {
        expect(chooseEncoding('br;q=0, gzip')).toBe('gzip')
        expect(chooseEncoding('br; q=0, gzip;q=0')).toBe('identity')
        expect(chooseEncoding('*')).toBe('br')
        expect(chooseEncoding('br;q=0, *')).toBe('gzip')
        expect(chooseEncoding('BR;Q=0.5')).toBe('br')
    })

    it('reads a header that arrived as several', () => {
        expect(chooseEncoding(['deflate', 'gzip'])).toBe('gzip')
    })
})

/** A sink that keeps every chunk it is given, in order. */
function collecting(): {out: PassThrough; bytes: () => Buffer} {
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (chunk: Buffer) => chunks.push(chunk))
    return {out, bytes: () => Buffer.concat(chunks)}
}

/**
 * What a client could read from these bytes so far, without the stream having ended. A decoder
 * told the input may stop mid-stream (`finishFlush`) gives back everything up to the last flush,
 * and nothing more — so this is only the whole lines when the flush really pushed them out.
 */
function readable(encoding: StreamEncoding, bytes: Buffer): string {
    if (encoding === 'br') {
        return brotliDecompressSync(bytes, {finishFlush: zlib.BROTLI_OPERATION_FLUSH}).toString()
    }
    if (encoding === 'gzip') return gunzipSync(bytes, {finishFlush: zlib.Z_SYNC_FLUSH}).toString()
    return bytes.toString()
}

const lines = [
    {key: 'pkg:npm/express', purls: ['pkg:npm/express@4.18.2'], status: 'resolved'},
    {key: null, purls: ['nonsense'], status: 'invalid', reason: 'not a purl'},
]

describe('createNdjsonWriter', () => {
    for (const encoding of ['br', 'gzip', 'identity'] as const) {
        it(`writes one JSON object per line, ending in \\n, in ${encoding}`, async () => {
            const {out, bytes} = collecting()
            const writer = createNdjsonWriter(out, encoding)

            await writer.write(lines.slice(0, 1))
            await writer.flush()
            await writer.write(lines.slice(1))
            await writer.write([{done: true, feeds: {}}])
            await writer.end()

            const text = encoding === 'br'
                ? brotliDecompressSync(bytes()).toString()
                : encoding === 'gzip'
                  ? gunzipSync(bytes()).toString()
                  : bytes().toString()
            expect(text.endsWith('\n')).toBe(true)
            expect(text.split('\n').slice(0, -1).map(line => JSON.parse(line))).toEqual([
                ...lines,
                {done: true, feeds: {}},
            ])
        })

        it(`makes a line readable before the end once it is flushed, in ${encoding}`, async () => {
            // The whole point of streaming: if the flush did not push the block out of the
            // compressor, the client would see nothing until `end`.
            const {out, bytes} = collecting()
            const writer = createNdjsonWriter(out, encoding)

            await writer.write(lines.slice(0, 1))
            await writer.flush()

            expect(out.writableEnded).toBe(false)
            expect(readable(encoding, bytes())).toBe(JSON.stringify(lines[0]) + '\n')

            await writer.write(lines.slice(1))
            await writer.flush()
            expect(readable(encoding, bytes())).toBe(lines.map(line => JSON.stringify(line) + '\n').join(''))

            await writer.end()
        })
    }

    it('waits for a full buffer to drain before taking the next batch', async () => {
        const out = new PassThrough({highWaterMark: 16})
        const writer = createNdjsonWriter(out, 'identity')
        let written = false

        const write = writer.write([{padding: 'x'.repeat(1024)}]).then(() => (written = true))
        await new Promise(resolve => setTimeout(resolve, 10))
        // Nobody is reading `out`, so the bytes are still sitting in its buffer.
        expect(written).toBe(false)

        out.resume()
        await write
        expect(written).toBe(true)
    })

    it('gives up waiting on a stream that has gone', async () => {
        const out = new PassThrough({highWaterMark: 16})
        const writer = createNdjsonWriter(out, 'gzip')

        const write = writer.write([{padding: 'x'.repeat(256 * 1024)}])
        out.destroy()

        // Neither hangs on a drain or a flush that can no longer come.
        await write
        await writer.flush()
        await writer.end()
        writer.destroy()
    })
})
