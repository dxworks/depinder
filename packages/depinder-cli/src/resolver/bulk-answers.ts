import type {PackageRecord} from '@depinder/core'
import {Cache} from '../cache/cache'
import {DepinderDependency, DepinderProject} from '../extension-points/extract'
import {LibraryInfo} from '../extension-points/library-info'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {log} from '../utils/logging'
import {timePhase} from '../utils/profile'
import {getVulnerabilitiesFromGithub} from '../utils/vulnerabilities'
import {toLibraryInfo} from './adapter'
import {answeredPurls, answeredThisProcess} from './bulk-memory'
import {ResolvedEntry} from './client'

/** GitHub advisory lookups at once for answers the resolver gave. */
const ADVISORY_LOOKUP_CONCURRENCY = 8

/** Phase 2a's result: who owns each purl, and whose advisories phase 3 will read. */
export interface PurlOwners {
    /** Every purl in the run, deduped, with the (plugin, dep) pairs that own it. */
    byPurl: Map<string, {plugin: Plugin, dep: DepinderDependency}[]>
    /** Cache keys with a dependency in a project no SBOM scan answered for. */
    advisoriesRead: Set<string>
    /** Cache keys whose projects' findings were still on their way, by those projects: settled in phase 2g. */
    advisoriesUndecided: Map<string, DepinderProject[]>
}

type AdvisoryLookup = {cacheKey: string, advisoryEcosystem: string, lib: LibraryInfo, updatedAt: number}

/**
 * The `updated_at` a resolver answer is cached with: the server's `confirmed_at`, the latest
 * instant it can show the facts matched the registry, in epoch milliseconds.
 *
 * Stamping "now" instead would make a package the server last confirmed days ago — every
 * `refreshing` one, by definition — look fresh locally for a full max age, so the stale facts would be
 * reused run after run without the server ever being asked again. Absent, `null` or unparseable
 * means "no proof of when", which is `0`: written already expired. Never later than now, in case
 * the server's clock runs ahead of this one.
 */
export function confirmedAtMs(confirmedAt: string | null | undefined, now = Date.now()): number {
    const ms = confirmedAt ? Date.parse(confirmedAt) : NaN
    return Number.isFinite(ms) ? Math.min(ms, now) : 0
}

/**
 * Phases 2d–2g of the bulk phase: writes each usable answer to the cache as it arrives, hands on
 * the answers an earlier source of the process took, and follows the writes with the GitHub
 * advisory lookups phase 3 will read. Nothing in here throws into the resolver's stream: a failed
 * write is kept and rethrown by `throwIfWriteFailed` once the phase is over.
 */
export class BulkAnswerWriter {
    /** Cache keys written from resolver answers, `${ecosystem}:${library}`. */
    readonly written = new Set<string>()
    /** The objects written (or handed on), by cache key, for phase 3. */
    readonly libs = new Map<string, LibraryInfo>()
    /** How many answers were usable. */
    resolved = 0
    private readonly taken = new Set<string>()
    private readonly lookups: AdvisoryLookup[] = []
    private readonly undecidedLookups: AdvisoryLookup[] = []
    private nextLookup = 0
    private readonly workers = new Set<Promise<void>>()
    private lookupWorkers = 0
    private writeFailure: {error: unknown} | undefined

    constructor(private readonly cache: Cache, private readonly owners: PurlOwners, private readonly refresh: boolean) {}

    // Phase 2d — each usable answer → one cache write per (ecosystem, library) key it belongs to,
    // there and then. `take` runs inside the client's line handler, so the row is written — one
    // autocommit statement in SQLite — before the next line is even parsed: a run killed halfway
    // through the stream keeps every answer that had arrived. For the same reason it must not
    // throw: an exception here would read to the client as a broken stream.
    //
    // Each key gets its own LibraryInfo: two plugins can share a purl and not an advisory
    // ecosystem, so they must not share one object to write vulnerabilities into.
    readonly take = (purl: string, answer: ResolvedEntry): void => {
        if (this.taken.has(purl)) return
        this.taken.add(purl)
        // A `refreshing` package is one the server could not refetch before the deadline, and it
        // carries facts older than this run's cutoff. They are better than nothing — unless the run
        // said `--refresh`, which is exactly a request for nothing older than the run, and the
        // registry fallback gets it.
        const usable = answer.status === 'resolved' || (answer.status === 'refreshing' && !this.refresh)
        if (!usable || !answer.package) return
        this.resolved++
        const githubToken = !!process.env.GH_TOKEN
        // When the server last confirmed these facts, not when they reached us: a `refreshing`
        // answer is older than the cutoff, so its row is written already expired. This run still
        // uses it, from `libs`; the next run asks the server for it again.
        const updatedAt = confirmedAtMs(answer.package.confirmed_at)
        answeredPurls.set(purl, {pkg: answer.package, updatedAt})
        for (const {plugin, dep} of this.owners.byPurl.get(purl) ?? []) {
            this.writeKey(`${ecosystemOf(plugin)}:${dep.name}`, plugin, answer.package, updatedAt, githubToken)
        }
        this.pump()
    }

    // Phase 2f — the purls an earlier source already asked about: never sent again. Under a key the
    // earlier source wrote, its very object is handed on; under a key it did not (the same purl,
    // named differently by this source's parser), the earlier answer is written now, with the
    // `updated_at` the server gave it. Advisories follow the same rule as a fresh answer.
    reuseEarlierAnswers(reusedPurls: string[]): void {
        const hasGithubToken = !!process.env.GH_TOKEN
        for (const purl of reusedPurls) {
            for (const {plugin, dep} of this.owners.byPurl.get(purl) ?? []) {
                const cacheKey = `${ecosystemOf(plugin)}:${dep.name}`
                if (this.libs.has(cacheKey)) continue
                const earlier = answeredThisProcess.get(cacheKey)
                if (earlier) {
                    this.libs.set(cacheKey, earlier.lib)
                    this.queueLookup(cacheKey, plugin, earlier.lib, earlier.updatedAt, hasGithubToken)
                    continue
                }
                const answer = answeredPurls.get(purl)
                if (answer) this.writeKey(cacheKey, plugin, answer.pkg, answer.updatedAt, hasGithubToken)
            }
        }
        this.pump()
    }

    /** Resolves once every write and advisory lookup started so far has finished. */
    async settled(): Promise<void> {
        while (this.workers.size > 0) await Promise.all(this.workers)
    }

    // Phase 2g — the lookups held back for projects whose findings were not attached yet. The
    // rule, applied once the flags are final: a server answer, or a local scan that produced a
    // report, sets the flag and the lookup is never made; a fallback that found no scanner leaves
    // it unset, and the lookup is made exactly as it would have been without a server. Waiting
    // here costs nothing on the usual path — there is nothing to wait for unless GH_TOKEN is set
    // and some library's advisories are still unknown.
    async lookUpUndecided(vulnerabilitiesReady: Promise<unknown> | undefined): Promise<void> {
        if (this.undecidedLookups.length === 0) return
        await timePhase('vuln:server-wait', () => vulnerabilitiesReady)
        for (const lookup of this.undecidedLookups) {
            const readers = this.owners.advisoriesUndecided.get(lookup.cacheKey) ?? []
            if (lookup.lib.vulnerabilities === undefined && readers.some(it => !it.exactVersionVulnerabilities)) this.lookups.push(lookup)
        }
        this.pump()
        await this.settled()
    }

    throwIfWriteFailed(): void {
        if (this.writeFailure) throw this.writeFailure.error
    }

    // One cache key's write of an answer, from `take` or from an answer an earlier source took.
    private writeKey(cacheKey: string, plugin: Plugin, pkg: PackageRecord, updatedAt: number, githubToken: boolean): void {
        if (this.written.has(cacheKey)) return
        this.written.add(cacheKey)
        const lib = toLibraryInfo(pkg)
        try {
            this.cache.set(cacheKey, lib, updatedAt)
        } catch (error) {
            this.writeFailure ??= {error}
            return
        }
        // Handed to phase 3 as it is, so the entry written here is not read straight back out of
        // the database a moment later. The `cache.set` above is what makes it durable and what
        // every later run reads.
        this.libs.set(cacheKey, lib)
        answeredThisProcess.set(cacheKey, {lib, updatedAt})
        this.queueLookup(cacheKey, plugin, lib, updatedAt, githubToken)
    }

    // An advisory lookup, when phase 3 will read its result: the plugin has a GitHub advisory
    // ecosystem, there is a token, some project of this source without scan findings uses the
    // library, and the object has no advisories yet — an answer reused from an earlier source may
    // have been taken where every project had scan findings, and so never looked up.
    private queueLookup(cacheKey: string, plugin: Plugin, lib: LibraryInfo, updatedAt: number, githubToken: boolean): void {
        const advisoryEcosystem = plugin.checker?.githubSecurityAdvisoryEcosystem
        if (!advisoryEcosystem || !githubToken) return
        if (lib.vulnerabilities !== undefined) return
        if (this.owners.advisoriesRead.has(cacheKey)) this.lookups.push({cacheKey, advisoryEcosystem, lib, updatedAt})
        else if (this.owners.advisoriesUndecided.has(cacheKey)) this.undecidedLookups.push({cacheKey, advisoryEcosystem, lib, updatedAt})
    }

    // Up to ADVISORY_LOOKUP_CONCURRENCY workers drain the lookup queue; one that finds it empty ends, and
    // the next answer starts a new one. A worker that ends pumps once more, for a lookup queued in
    // the moment between its last look at the queue and its leaving the set.
    private pump(): void {
        while (this.lookupWorkers < ADVISORY_LOOKUP_CONCURRENCY && this.nextLookup < this.lookups.length) {
            this.lookupWorkers++
            const worker: Promise<void> = this.drain()
                .catch(error => { this.writeFailure ??= {error} })
                .finally(() => {
                    this.workers.delete(worker)
                    this.lookupWorkers--
                    this.pump()
                })
            this.workers.add(worker)
        }
    }

    // Phase 2e — GHSA advisories, per key, and a second write with them filled in: the server
    // returns registry facts only. The registry fallback path does the same lookup, on the same
    // terms, because a resolved package is a cache hit in phase 3 and a cache hit never fetches
    // advisories: without it a cold run with GH_TOKEN would empty the vulnerability columns of
    // every project no scanner covered. It is one GraphQL call per cache key, eight at a time, and
    // only for a key phase 3 will read advisories from (`advisoriesRead`). A failed lookup keeps
    // the row already written. The cost of writing first: a run killed between the two writes
    // leaves a row with no advisories, which only matters when no scanner ran.
    private async drain(): Promise<void> {
        while (this.nextLookup < this.lookups.length) {
            const {cacheKey, advisoryEcosystem, lib, updatedAt} = this.lookups[this.nextLookup++]
            try {
                lib.vulnerabilities = await getVulnerabilitiesFromGithub(advisoryEcosystem, lib.name)
            } catch (e: any) {
                log.warn(`Vulnerability lookup failed for ${lib.name}: ${e.message ?? e}`)
                continue
            }
            // Same `updated_at` as the first write: the advisories are not a reconfirmation of the
            // registry facts.
            this.cache.set(cacheKey, lib, updatedAt)
        }
    }
}
