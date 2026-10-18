import {timingSafeEqual} from 'node:crypto'
import {constants as zlib} from 'node:zlib'
import compress from '@fastify/compress'
import type {FastifyError, FastifyInstance, FastifyReply, FastifyRequest} from 'fastify'
import {BadRequestError} from './errors.js'
import {errorMessage, type Logger} from '@depinder/core'

/**
 * The HTTP plumbing every server in this repo shares: compression, the bearer token, and how a
 * failed request is answered. The resolver (`src/resolver/api/server.ts`) and the vulnerability
 * server (`src/vuln/server.ts`) are different apps with different routes, but a caller should not be able
 * to tell them apart by how they authenticate, compress or fail.
 */

export const BODY_LIMIT_BYTES = 10 * 1024 * 1024

/**
 * Brotli 4 and gzip 1, the same cheap end of both scales the compress plugin used: on a 7 MB answer
 * they give 5.8x and 3.9x, while brotli's default quality would spend 36 s on it for another 20%.
 * The resolver's own `/resolve` stream (`src/resolver/api/stream.ts`) compresses at these too.
 */
export const BROTLI_QUALITY = 4
export const GZIP_LEVEL = 1

/** Below this a response is not worth the CPU or the header. */
export const COMPRESS_THRESHOLD_BYTES = 1024

/**
 * Compression for every route that does not opt out with `{compress: false}`.
 *
 * The same cheap end of both scales as `src/resolver/api/stream.ts` — brotli's *default* quality spends 36 s on a
 * 7 MB payload to save another 20%. Nothing is compressed unless the client asked for an encoding
 * it can read, so a caller that sends no `accept-encoding` is answered exactly as before.
 *
 * Awaited, and before the routes: the plugin works by an `onSend` hook, and a hook only reaches
 * routes added after it. That is why building a server is asynchronous.
 */
export async function registerCompress(app: FastifyInstance): Promise<void> {
    await app.register(compress, {
        global: true,
        // Responses only. The plugin would also decompress request bodies, which nothing sends and
        // which is not what this is for.
        globalDecompression: false,
        threshold: COMPRESS_THRESHOLD_BYTES,
        encodings: ['br', 'gzip', 'deflate'],
        brotliOptions: {params: {[zlib.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY}},
        zlibOptions: {level: GZIP_LEVEL},
    })
}

/** Every route outside `publicPaths` needs `Authorization: Bearer <token>`. */
export function registerAuth(app: FastifyInstance, token: string, log: Logger, publicPaths: ReadonlySet<string>): void {
    const expected = Buffer.from(token)
    app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const path = request.url.split('?')[0] ?? request.url
        if (publicPaths.has(path)) return
        if (!isAuthorised(request.headers.authorization, expected)) {
            log.warn('unauthorised request', {path, ip: request.ip})
            await reply.code(401).send({error: 'unauthorised'})
        }
    })
}

/**
 * `BadRequestError` is a 400 with its message; Fastify's own 4xx pass through; anything else is a
 * 500 that says "internal error" and nothing more.
 */
export function registerErrorHandler(app: FastifyInstance, log: Logger): void {
    app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
        if (error instanceof BadRequestError) return reply.code(400).send({error: error.message})
        // Fastify's own body/parse failures already carry a 4xx status.
        const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500
        // The cause is never swallowed: the caller is told "internal error" and nothing else, so
        // this line is the only record of what actually happened. `code` is what carries a
        // Postgres SQLSTATE (`40P01` is a deadlock victim); a pool checkout that timed out has no
        // code and arrives as the plain message "timeout exceeded when trying to connect".
        if (status >= 500) {
            log.error('request failed', {
                path: request.url,
                error: errorMessage(error),
                code: error.code,
            })
        }
        return reply.code(status).send({error: status >= 500 ? 'internal error' : error.message})
    })
}

/**
 * A signal that fires when the caller goes away mid-request.
 *
 * It watches the *reply*, not the request, and that is the whole subtlety. On Node 24 with Fastify
 * 5 `request.raw` emits `close` as soon as the request body has been read — which for a `/resolve`
 * is before the handler is even entered, `complete` true and `aborted` false — so a handler that
 * listened there would abandon every request immediately; and `aborted`, deprecated since Node 16,
 * never fires at all for a body that arrived whole. The response stream is the one that knows: node
 * closes `reply.raw` when the socket goes, and `writableFinished` separates a socket that left
 * early from one we finished writing to.
 */
export function clientGone(reply: FastifyReply): AbortSignal {
    const controller = new AbortController()
    reply.raw.once('close', () => {
        if (!reply.raw.writableFinished) controller.abort()
    })
    return controller.signal
}

/** Constant-time comparison, so a wrong token leaks nothing through timing. */
function isAuthorised(header: string | undefined, expected: Buffer): boolean {
    if (!header) return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (!match?.[1]) return false
    const given = Buffer.from(match[1])
    if (given.length !== expected.length) return false
    return timingSafeEqual(given, expected)
}
