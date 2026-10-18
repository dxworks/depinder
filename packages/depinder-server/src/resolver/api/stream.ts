import {finished, type Writable} from 'node:stream'
import {constants as zlib, createBrotliCompress, createGzip, type BrotliCompress, type Gzip} from 'node:zlib'
import {BROTLI_QUALITY, GZIP_LEVEL} from '../../shared/http-server.js'

/**
 * The bytes of a streamed answer: which encoding, and an NDJSON writer that can be flushed.
 *
 * `@fastify/compress` is not used for `/resolve`, because it pipes a stream through zlib with no
 * way to flush it: every line would sit inside the compressor until it had a full block, which is
 * the whole stream for anything but the largest answers, and the client would see nothing until
 * the end — exactly what streaming is meant to stop. So the route compresses for itself, here,
 * and flushes after each batch of lines.
 *
 * A flush is per batch, never per line. It costs a few bytes and keeps the compression window, so
 * a stream flushed a dozen times compresses almost as well as one body; flushing each of two
 * thousand lines would cost far more for nothing a client could use sooner.
 *
 * Kept apart from Fastify, so it can be tested against a plain stream.
 */

export type StreamEncoding = 'br' | 'gzip' | 'identity'

/**
 * The encoding to answer in: brotli if the caller reads it, else gzip, else none. A `q=0` refuses
 * an encoding, and `*` stands for any encoding the header does not name. Anything else in the
 * header (`deflate`, `zstd`) is ignored rather than refused.
 */
export function chooseEncoding(acceptEncoding: string | string[] | undefined): StreamEncoding {
    const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '')
    const quality = new Map<string, number>()
    for (const part of header.split(',')) {
        const [name, ...params] = part.split(';')
        const coding = name?.trim().toLowerCase()
        if (!coding) continue
        let q = 1
        for (const param of params) {
            const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)
            if (match) q = Number(match[1])
        }
        quality.set(coding, Number.isNaN(q) ? 0 : q)
    }
    const accepts = (coding: string): boolean => (quality.get(coding) ?? quality.get('*') ?? 0) > 0
    if (accepts('br')) return 'br'
    if (accepts('gzip')) return 'gzip'
    return 'identity'
}

/**
 * Writes newline-delimited JSON to `out`, compressed in `encoding`.
 *
 * Every call waits for what it needs to: `write` for the buffer to drain when it is full, so a slow
 * link makes the producer slow down instead of making this process hold the whole answer in memory
 * again; `flush` for the compressor to have handed its bytes on; `end` for `out` to finish. None of
 * them waits forever on a socket that has gone: once `out` closes they all return at once.
 */
export interface NdjsonWriter {
    readonly encoding: StreamEncoding
    /** One JSON line per value, `\n` after each. Not flushed: see {@link flush}. */
    write(lines: readonly unknown[]): Promise<void>
    /** Pushes everything written so far through the compressor, so the client can read it now. */
    flush(): Promise<void>
    /** Ends the stream cleanly, and resolves once `out` has finished (or gone). */
    end(): Promise<void>
    /** Drops the stream without another byte, for a caller who has already left. */
    destroy(): void
}

export function createNdjsonWriter(out: Writable, encoding: StreamEncoding): NdjsonWriter {
    const compressor: BrotliCompress | Gzip | undefined =
        encoding === 'br'
            ? createBrotliCompress({params: {[zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY}})
            : encoding === 'gzip'
              ? createGzip({level: GZIP_LEVEL})
              : undefined
    const target: Writable = compressor ?? out

    // `out` going away — a socket reset, a caller that hung up — is not an error anyone can act on
    // here: the route already hears it through `clientGone` and stops producing. Without a listener
    // it would be an unhandled 'error' event, which takes the process down with it.
    let gone = out.destroyed || out.writableFinished
    const onGone = new Set<() => void>()
    const markGone = (): void => {
        gone = true
        for (const resolve of [...onGone]) resolve()
    }
    out.once('close', markGone)
    out.on('error', markGone)
    if (compressor) {
        compressor.on('error', markGone)
        compressor.pipe(out)
    }

    /** Resolves when `wait` says so, or as soon as `out` has gone, whichever is first. */
    const untilOr = (wait: (done: () => void) => void): Promise<void> =>
        new Promise<void>(resolve => {
            if (gone) return resolve()
            const done = (): void => {
                onGone.delete(done)
                resolve()
            }
            onGone.add(done)
            wait(done)
        })

    return {
        encoding,

        async write(lines) {
            if (gone || lines.length === 0) return
            let text = ''
            for (const line of lines) text += JSON.stringify(line) + '\n'
            if (!target.write(text)) await untilOr(resolve => target.once('drain', resolve))
        },

        async flush() {
            if (gone || !compressor) return
            // BROTLI_OPERATION_FLUSH and Z_SYNC_FLUSH both end the current block on a byte boundary
            // without resetting the window: everything so far becomes decodable, and what follows
            // still compresses against it.
            const kind = encoding === 'br' ? zlib.BROTLI_OPERATION_FLUSH : zlib.Z_SYNC_FLUSH
            await untilOr(resolve => compressor.flush(kind, resolve))
        },

        async end() {
            if (gone) return
            await untilOr(resolve => {
                // `pipe` ends `out` once the compressor has emitted its last block.
                finished(out, () => resolve())
                target.end()
            })
        },

        destroy() {
            if (compressor) {
                compressor.unpipe(out)
                compressor.destroy()
            }
        },
    }
}
