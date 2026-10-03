import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import Fastify, {type FastifyInstance} from 'fastify'
import {BODY_LIMIT_BYTES, clientGone, registerAuth, registerCompress, registerErrorHandler} from '../shared/http-server.js'
import type {Logger} from '../shared/log.js'
import type {VulnConfig} from './config.js'
import {BusyError, type ScanLimiter} from './limiter.js'
import {buildVulnerabilityIndex, type Vulnerability} from './merge/index.js'
import {parseVulnRequest, TooManyPurlsError} from './request.js'
import {buildSbom} from './sbom.js'
import {SCAN_DIR_PREFIX, scanBoth, type ScanDirs, ScanError, type ScanReports, type ScannerVersions} from './scanners.js'
import {type DatabaseSource, type Lease, publicBuild} from './source.js'

/** `/health` is the only unauthenticated route: container health checks have no token. */
const PUBLIC_PATHS = new Set(['/health'])

/** Scans the SBOM at a path against the leased folders. `scanBoth` unless a test says otherwise. */
export type RunScan = (sbomPath: string, dirs: ScanDirs, signal: AbortSignal) => Promise<ScanReports>

interface VulnDeps {
    config: VulnConfig
    log: Logger
    limiter: ScanLimiter
    /** Frozen folders or managed builds (`source.ts`). */
    source: DatabaseSource
    /** Read once at startup (`scannerVersions`), reported on every answer. */
    versions: ScannerVersions
    /** Overridden in tests. */
    runScan?: RunScan
}

/** The vulnerability server: the same plumbing as the resolver's (`src/shared/http-server.ts`), its own routes. */
export async function createVulnServer(deps: VulnDeps): Promise<FastifyInstance> {
    const {config, log, limiter, source} = deps
    const app = Fastify({bodyLimit: BODY_LIMIT_BYTES, logger: false})
    const runScan: RunScan = deps.runScan ?? ((sbomPath, dirs, signal) => scanBoth(sbomPath, dirs, config, signal))

    await registerCompress(app)
    registerAuth(app, config.apiToken, log, PUBLIC_PATHS)
    registerErrorHandler(app, log)

    // Ready means both tools have a usable build; until then every scan would fail, so the
    // container is reported unhealthy rather than up. Stale is still a 200: a restart cannot make
    // an upstream publish, and the old data keeps being served, labelled with its age.
    app.get('/health', async (_request, reply) => {
        await source.refresh()
        const {ready, status, reason, trivy, grype} = source.health()
        const databases = {...trivy && {trivy}, ...grype && {grype}}
        if (!ready) return reply.code(503).send({status, reason, databases})
        return {status, scans: limiter.stats(), databases}
    })

    /**
     * Purls in, findings out, in one JSON body. Only vulnerable purls are under `vulnerabilities`:
     * a purl that was scanned and is not listed is clean. What could not be scanned is listed
     * under `unsupported` with the reason, and the answer says which databases and scanners
     * produced it, because the same purls can legitimately get different findings tomorrow.
     */
    app.post('/vulnerabilities', async (request, reply) => {
        const started = Date.now()
        let parsed
        try {
            parsed = parseVulnRequest(request.body, config.maxPurls)
        } catch (e) {
            if (e instanceof TooManyPurlsError) return reply.code(413).send({error: e.message, max: e.max})
            throw e
        }

        // Refused before it queues: no point waiting for a slot to learn there is nothing to read.
        await source.refresh()
        const health = source.health()
        if (!health.ready) return reply.code(503).send({error: 'databases not ready', reason: health.reason})

        // The builds the answer names are the builds that were scanned: the lease's, never
        // whatever is current by the time the answer is written.
        const answer = (lease: Lease, vulnerabilities: Record<string, Vulnerability[]>) => ({
            vulnerabilities,
            unsupported: parsed.unsupported,
            databases: {trivy: publicBuild(lease.trivy), grype: publicBuild(lease.grype)},
            scanners: {trivy: deps.versions.trivy, grype: deps.versions.grype},
        })
        if (parsed.scan.length === 0) {
            const lease = source.lease()
            if (!lease.ready) return reply.code(503).send({error: 'databases not ready', reason: lease.reason})
            lease.release()
            return answer(lease, {})
        }

        const signal = clientGone(reply)
        let release
        const queued = Date.now()
        try {
            release = await limiter.acquire(signal)
        } catch (e) {
            if (e instanceof BusyError) {
                log.warn('vulnerability scan refused: busy', {purls: parsed.scan.length, scans: limiter.stats()})
                return reply.code(503).header('retry-after', '1').send({error: 'busy'})
            }
            // The caller hung up while waiting for a slot. There is no socket left to answer on,
            // so hijacking is how Fastify is told the reply is dealt with, as `/resolve` does.
            if (signal.aborted) {
                reply.hijack()
                return
            }
            throw e
        }
        // Only the wait for a slot: what VULN_MAX_SCANS and VULN_MAX_QUEUED are tuned by.
        const queueMs = Date.now() - queued

        // Leased only now, so a request that waited in line scans the newest builds. Synchronous:
        // nothing can be installed between the slot and the lease.
        const lease = source.lease()
        if (!lease.ready) {
            release()
            return reply.code(503).send({error: 'databases not ready', reason: lease.reason})
        }

        // Nothing is sent from inside the `try`: `reply.send` answers at once, and the caller must
        // not hear back before the scan's folder is gone.
        let dir: string | undefined
        let outcome: {reports: ScanReports} | {failed: unknown}
        try {
            dir = await mkdtemp(join(config.tmpDir, SCAN_DIR_PREFIX))
            const sbomPath = join(dir, 'sbom.json')
            await writeFile(sbomPath, buildSbom(parsed.scan))
            outcome = {reports: await runScan(sbomPath, {trivy: lease.trivy.dir, grype: lease.grype.dir}, signal)}
        } catch (e) {
            outcome = {failed: e}
        } finally {
            // Both scanners have exited: the builds may go, if they have been replaced meanwhile.
            lease.release()
            release()
            if (dir) await rm(dir, {recursive: true, force: true})
        }

        if ('failed' in outcome) {
            const e = outcome.failed
            if (!(e instanceof ScanError)) throw e
            if (e.reason === 'aborted' && signal.aborted) {
                // Not a server error: the caller left, and its scan with it.
                log.info('vulnerability scan abandoned: client gone', {purls: parsed.scan.length})
                reply.hijack()
                return
            }
            log.error('vulnerability scan failed', {
                scanner: e.scanner,
                reason: e.reason,
                exitCode: e.exitCode,
                stderr: lastLine(e.stderrTail),
                purls: parsed.scan.length,
            })
            return reply.code(500).send({error: 'scan failed', scanner: e.scanner, reason: e.reason})
        }
        const {reports} = outcome

        const refs = new Map(parsed.scan.map((item, i) => [`c${i}`, item.purl]))
        const purlRefs = new Map<string, string>()
        parsed.scan.forEach((item, i) => {
            if (!purlRefs.has(item.bare)) purlRefs.set(item.bare, `c${i}`)
        })
        const {index, unmapped} = buildVulnerabilityIndex(reports.trivy, reports.grype, refs, purlRefs)
        if (unmapped > 0) log.warn('scanner findings with an unknown bom-ref were dropped', {count: unmapped})

        const totalMs = Date.now() - started
        log.info('vulnerabilities scanned', {
            purls: parsed.scan.length,
            unsupported: parsed.unsupported.length,
            vulnerable: index.size,
            queueMs,
            trivyMs: reports.trivyMs,
            grypeMs: reports.grypeMs,
            totalMs,
        })
        // The same times, for the caller: `bench/micro/vuln-bench.cjs` reads the queue time from here.
        reply.header('server-timing',
            `queue;dur=${queueMs}, trivy;dur=${reports.trivyMs}, grype;dur=${reports.grypeMs}, total;dur=${totalMs}`)
        return answer(lease, Object.fromEntries(index))
    })

    return app
}

function lastLine(text: string): string | undefined {
    const lines = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map(it => it.trim()).filter(Boolean)
    return lines[lines.length - 1]
}
