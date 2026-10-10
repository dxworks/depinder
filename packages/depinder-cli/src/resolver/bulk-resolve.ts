import {minimatch} from 'minimatch'
import {Cache} from '../cache/cache'
import {DepinderProject} from '../extension-points/extract'
import {LibraryInfo} from '../extension-points/library-info'
import {ecosystemOf, Plugin} from '../extension-points/plugin'
import {blacklistedGlobs} from '../utils/blacklist'
import {log} from '../utils/logging'
import {count} from '../utils/profile'
import {BulkAnswerWriter, PurlOwners} from './bulk-answers'
import {askedThisProcess} from './bulk-memory'
import {resolvePurls} from './client'
import {ResolverConfig} from './config'

/** A plugin and the projects its parser produced: what phase 1 hands to phases 2 and 3. */
export interface PluginProjects {
    plugin: Plugin
    projects: DepinderProject[]
}

/** What the bulk phase left behind for phase 3: the cache keys it filled, and a count or two. */
export interface BulkResolveOutcome {
    /** Cache keys written from resolver answers, `${ecosystem}:${library}`. */
    written: Set<string>
    /**
     * The very objects that were written, under the same keys — and, for a purl an earlier source
     * of the same process already asked about, the objects that source took (`answeredThisProcess`).
     *
     * An optimisation, not a second cache: the SQLite row remains the durable copy and this map
     * dies with the run. It saves phase 3 re-reading what phase 2 built seconds earlier — a `has`
     * plus a `get`, so two SQLite statements and a `JSON.parse` of ~10 KB, once per dependency
     * (15,587 round trips on the warm benchmark).
     */
    libs: Map<string, LibraryInfo>
    /** How many distinct purls were actually asked about, after dedupe, the cache check and the purls already asked this process. */
    requested: number
    /** How many of those came back `resolved`. */
    resolved: number
}

/** Phase 2b's split of the run's purls. */
interface AskPlan {
    /** The purls to send. */
    wanted: string[]
    /** The purls an earlier source of this process already asked about. */
    reusedPurls: string[]
    /** How many of `wanted` are expired rather than missing; only for the log line. */
    expired: number
    alreadyAsked: number
}

/**
 * Phase 2: one ask of the resolver for every purl the cache cannot answer, written into the same
 * cache phase 3 reads. Each purl is asked once per process, however many sources name it.
 *
 * The map is global on purpose. A purl identifies a library-version the same way whichever plugin
 * found it, so `sbom-java` reading a Trivy and a Syft SBOM of the same repository, or twenty projects sharing a
 * dependency, produce one entry and one question. What comes back `resolved` is written under
 * every cache key that purl belongs to — the key is per ecosystem, and two plugins can share one —
 * so `cacheHit` in phase 3 finds it and the registry fallback is never called. Everything else
 * (`pending`, `not_found`, `invalid`, or a resolver that never answered) is left alone and falls
 * through to the registry fallback and the miss cache.
 *
 * Answers arrive as a stream, and each one is written as it arrives rather than after the last:
 * the phase returns once the stream has ended and every advisory lookup it started has finished.
 *
 * `resolve` is a parameter so the phase can be tested without a server.
 *
 * `vulnerabilitiesReady`, when given, settles once every project's findings are attached — the
 * vulnerability server's, or the local scan's it fell back to. Until then a project without
 * `exactVersionVulnerabilities` is undecided rather than a reader of advisories: see phase 2g.
 */
export async function bulkResolve(
    config: ResolverConfig,
    pluginProjects: PluginProjects[],
    cache: Cache,
    options: {refresh?: boolean, vulnerabilitiesReady?: Promise<unknown>} = {},
    resolve: typeof resolvePurls = resolvePurls
): Promise<BulkResolveOutcome> {
    const owners = collectPurlOwners(pluginProjects, !!options.vulnerabilitiesReady)
    const plan = planAsk(owners, cache, !!options.refresh)
    logAskPlan(plan, !!options.refresh)
    // Marked before the ask, not after it: whatever the server makes of them, they are not asked again.
    for (const purl of plan.wanted) askedThisProcess.add(purl)

    // Phase 2c — the server call: resolver/client.ts POSTs these purls to <resolver-url>/resolve, in
    // chunks, all at once, and reads each answer as a stream. Every usable answer is taken and
    // written to the cache the moment its line arrives (phase 2d), while the server is still fetching
    // the packages it did not know; the advisory lookups that are worth making follow behind it
    // (phase 2e), so none of that work waits for the slowest package of the run.
    const writer = new BulkAnswerWriter(cache, owners, !!options.refresh)
    writer.reuseEarlierAnswers(plan.reusedPurls)
    if (plan.wanted.length > 0) {
        const answers = await resolve(config, plan.wanted, log, writer.take)
        // The map holds every answer the stream delivered, so this only catches one `onItem` did
        // not see; `take` ignores a purl it has already had.
        for (const [purl, answer] of answers) writer.take(purl, answer)
    }
    // The phase ends when the stream has AND every write and lookup it started has: phase 3 must
    // not read a key while its advisories are still being added.
    await writer.settled()
    await writer.lookUpUndecided(options.vulnerabilitiesReady)
    writer.throwIfWriteFailed()

    const {written, libs, resolved} = writer
    if (plan.wanted.length === 0) return {written, libs, requested: 0, resolved: 0}
    count('resolver:cache-write', written.size)
    log.info(`Resolver filled ${written.size} cache entries from ${resolved} of ${plan.wanted.length} requested package(s)`)
    return {written, libs, requested: plan.wanted.length, resolved}
}

/**
 * Phase 2a — every purl in the run, deduped, with the (plugin, dep) pairs that own it; and the
 * cache keys whose advisories phase 3 will actually read: those with at least one dependency in a
 * project no SBOM scan answered for (`exactVersionVulnerabilities` unset, see
 * `plugins/sbom/index.ts`). A project the scanners covered takes its findings from the scan and
 * never looks at `lib.vulnerabilities`, so a GitHub call for it would be paid and thrown away.
 * The flag is set while parsing, in phase 1, so it is already known here — unless the findings
 * come from the vulnerability server, whose answer may still be on its way: then a project
 * without the flag is only undecided (`advisoriesUndecided`, settled in phase 2g).
 */
function collectPurlOwners(pluginProjects: PluginProjects[], findingsPending: boolean): PurlOwners {
    const owners: PurlOwners = {byPurl: new Map(), advisoriesRead: new Set(), advisoriesUndecided: new Map()}
    for (const {plugin, projects} of pluginProjects) {
        for (const project of projects) {
            for (const dep of Object.values(project.dependencies)) {
                if (!dep.purl) continue
                // The same filter phase 3 applies, so the resolver is never asked about a library
                // this run has been told to ignore.
                if (blacklistedGlobs.some(glob => minimatch(dep.name, glob))) continue
                const entries = owners.byPurl.get(dep.purl)
                if (entries) entries.push({plugin, dep})
                else owners.byPurl.set(dep.purl, [{plugin, dep}])
                if (project.exactVersionVulnerabilities) continue
                const key = `${ecosystemOf(plugin)}:${dep.name}`
                if (!findingsPending) {
                    owners.advisoriesRead.add(key)
                    continue
                }
                const undecided = owners.advisoriesUndecided.get(key)
                if (!undecided) owners.advisoriesUndecided.set(key, [project])
                else if (!undecided.includes(project)) undecided.push(project)
            }
        }
    }
    return owners
}

/**
 * Phase 2b — drop the purls this process already asked about, and those the local cache already
 * covers; what is left is the ask list.
 */
function planAsk({byPurl}: PurlOwners, cache: Cache, refresh: boolean): AskPlan {
    const plan: AskPlan = {wanted: [], reusedPurls: [], expired: 0, alreadyAsked: 0}
    for (const [purl, entries] of byPurl) {
        if (askedThisProcess.has(purl)) {
            // An earlier source asked, and the server's answer — or its silence — stands for the
            // process. What it answered is handed on under every key this source owns it by (phase 2f).
            count('resolver:already-asked')
            plan.alreadyAsked++
            plan.reusedPurls.push(purl)
            continue
        }
        const keys = new Set(entries.map(it => `${ecosystemOf(it.plugin)}:${it.dep.name}`))
        // Already cached under every key it would fill: phase 3 will hit the cache and never reach
        // a registry, so there is nothing to ask for. `--refresh` wants fresh facts, and the
        // resolver is the cheapest place to get them.
        if (!refresh && allCached(cache, keys)) {
            count('resolver:locally-cached')
            continue
        }
        // An expired entry is asked for like a missing one; counted apart only for the log line.
        if (!refresh && anyExpired(cache, keys)) {
            count('resolver:expired')
            plan.expired++
        }
        plan.wanted.push(purl)
    }
    return plan
}

function logAskPlan({wanted, expired, alreadyAsked}: AskPlan, refresh: boolean): void {
    if (wanted.length > 0) {
        log.info(`Asking the resolver about ${wanted.length} purl(s): `
            + (refresh ? 'every one re-checked' : `${wanted.length - expired} not cached, ${expired} expired`)
            + `${alreadyAsked ? `; ${alreadyAsked} already asked this run` : ''}`)
    } else {
        log.info(alreadyAsked
            ? `Nothing to resolve in bulk: every dependency is in the local cache or was already asked this run (${alreadyAsked})`
            : 'Nothing to resolve in bulk: every dependency is already in the local cache')
    }
}

function allCached(cache: Cache, keys: Set<string>): boolean {
    return [...keys].every(key => cache.has(key))
}

function anyExpired(cache: Cache, keys: Set<string>): boolean {
    return [...keys].some(key => cache.isExpired(key))
}
