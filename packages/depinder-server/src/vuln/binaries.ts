import {chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {errorMessage, type Logger} from '@depinder/core'
import {compareVersions} from './releases.js'
import type {ScannerName} from './scanners.js'
import {TOOLS} from './store.js'

/**
 * Which Trivy and Grype binary the server runs, and the downloaded ones on disk.
 *
 *   VULN_DATA_DIR/scanners/
 *     state.json              {"trivy": {"active", "previous", "rejected"}, "grype": {...}}
 *     trivy/<version>/trivy   a downloaded binary, never written again once installed
 *     grype/<version>/grype
 *     staging-<random>/       downloads land here; emptied at boot
 *     tuf/                    Sigstore's trust root (`signatures.ts`)
 *
 * `active: null` is the image's own binary (`TRIVY_BIN`/`GRYPE_BIN`, by default the one on PATH):
 * the baseline, always there, never deleted. A switch keeps the one before as `previous`, so a
 * downloaded binary that stops working at boot or at a later check is rolled back to it (and,
 * failing that, to the image's), and is recorded in `rejected` like a release that failed its
 * checks: never downloaded again. Two downloaded versions per tool are kept at most; an older one
 * is deleted at the switch. A scan already running keeps its open binary; a scan just starting has
 * taken its path from `active()` and finds it still there, since the binary it replaced is kept as
 * `previous`.
 *
 * A newer image wins: when the image's binary is at least the downloaded one's version, the image's
 * is used and the downloaded ones are deleted. So the version CI bakes into the image stays the
 * floor, and a rebuilt image is never held back by an older download.
 */

type ScannerSource = 'image' | 'pinned' | 'updated'

export interface ActiveScanner {
    bin: string
    version: string
    /** The image's binary, one an operator pinned with `TRIVY_BIN`/`GRYPE_BIN`, or a downloaded one. */
    source: ScannerSource
}

export type ActiveScanners = Record<ScannerName, ActiveScanner>

interface Rejection {
    reason: string
    at: string
    /** The database source it was checked against: a release refused for its schema may suit another. */
    db: string
}

interface ToolState {
    active: string | null
    previous: string | null
    rejected: Record<string, Rejection>
}

/** Rejections remembered per tool; the oldest go first. */
const MAX_REJECTED = 20

export interface ScannerBinaries {
    readonly root: string
    /** Per tool: may this process switch to downloaded binaries at all. */
    readonly selfUpdate: Record<ScannerName, boolean>
    /** Boot: empties staging, reads `state.json`, checks the binaries it names, deletes the rest. */
    open(): Promise<void>
    /** Synchronous, so that a scan's binaries are taken in the same tick as its databases. */
    active(): ActiveScanners
    state(tool: ScannerName): ToolState
    isRejected(tool: ScannerName, version: string, db: string): boolean
    newStaging(): Promise<string>
    /** Moves the checked binary at `staged` into place and makes it active; the active one becomes `previous`. */
    activate(tool: ScannerName, version: string, staged: string): Promise<void>
    reject(tool: ScannerName, version: string, reason: string, db: string): Promise<void>
    /** The active downloaded binary is broken: back to `previous`, or to the image's. */
    rollback(tool: ScannerName, reason: string, db: string): Promise<void>
}

export function createScannerBinaries(options: {
    dataDir: string
    /** The image's (or the pinned) binary per tool, with the version it reported at boot. */
    image: ActiveScanners
    /** Per tool: may this process switch to downloaded binaries at all. */
    selfUpdate: Record<ScannerName, boolean>
    /** What a binary says its version is; throws if it cannot. */
    probe(tool: ScannerName, bin: string): Promise<string>
    log: Logger
    now?: () => number
}): ScannerBinaries {
    const {image, selfUpdate, log} = options
    const now = options.now ?? Date.now
    const root = join(options.dataDir, 'scanners')
    const stateFile = join(root, 'state.json')
    const binPath = (tool: ScannerName, version: string): string => join(root, tool, version, tool)

    const state: Record<ScannerName, ToolState> = {
        trivy: {active: null, previous: null, rejected: {}},
        grype: {active: null, previous: null, rejected: {}},
    }
    const active: ActiveScanners = {...image}

    const save = async (): Promise<void> => {
        const tmp = `${stateFile}.tmp`
        await writeFile(tmp, JSON.stringify(state, null, 1) + '\n')
        await rename(tmp, stateFile)
    }

    const point = (tool: ScannerName): void => {
        const version = state[tool].active
        active[tool] = version ? {bin: binPath(tool, version), version, source: 'updated'} : image[tool]
    }

    const prune = (tool: ScannerName): Promise<void> => pruneVersions(join(root, tool), [state[tool].active, state[tool].previous], log)
    const addRejection = (tool: ScannerName, version: string, reason: string, db: string): void =>
        remember(state[tool], version, {reason, at: new Date(now()).toISOString(), db})

    return {
        root,
        selfUpdate,

        async open() {
            await mkdir(root, {recursive: true})
            for (const name of await readdir(root)) {
                if (name.startsWith('staging-')) await rm(join(root, name), {recursive: true, force: true})
            }
            try {
                Object.assign(state, parseState(await readFile(stateFile, 'utf8')))
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    log.warn('scanners/state.json unreadable; starting from the image\'s scanners', {error: errorMessage(e)})
                }
            }
            for (const tool of TOOLS) {
                const chosen = selfUpdate[tool]
                    ? await chooseAtBoot(tool, state[tool], image[tool].version, version => options.probe(tool, binPath(tool, version)), log)
                    : {active: null, previous: null, broken: null}
                if (chosen.broken) addRejection(tool, chosen.broken, 'failed its version check at boot', '')
                state[tool] = {...state[tool], active: chosen.active, previous: chosen.previous}
                point(tool)
                await prune(tool)
            }
            await save()
        },

        active: () => ({trivy: {...active.trivy}, grype: {...active.grype}}),

        state: tool => structuredClone(state[tool]),

        isRejected: (tool, version, db) => {
            const rejection = state[tool].rejected[version]
            // A boot failure (no `db`) counts against every database source.
            return !!rejection && (!rejection.db || rejection.db === db)
        },

        async newStaging() {
            await mkdir(root, {recursive: true})
            return mkdtemp(join(root, 'staging-'))
        },

        async activate(tool, version, staged) {
            const dest = binPath(tool, version)
            await rm(join(root, tool, version), {recursive: true, force: true})
            await mkdir(join(root, tool, version), {recursive: true})
            await chmod(staged, 0o755)
            await rename(staged, dest)
            const before = {...state[tool]}
            state[tool] = {...before, active: version, previous: before.active ?? null}
            try {
                await save()
            } catch (e) {
                state[tool] = before
                await rm(join(root, tool, version), {recursive: true, force: true})
                throw e
            }
            point(tool)
            await prune(tool)
        },

        async reject(tool, version, reason, db) {
            addRejection(tool, version, reason, db)
            await save()
        },

        async rollback(tool, reason, db) {
            const broken = state[tool].active
            if (!broken) return
            addRejection(tool, broken, reason, db)
            state[tool] = {...state[tool], active: state[tool].previous, previous: null}
            point(tool)
            await save()
            await prune(tool)
            log.warn('scanner rolled back', {tool, from: broken, to: active[tool].version, reason})
        },
    }
}

/** `state.json`, with anything that is not a plain `x.y.z` version dropped: it names folders. Throws if it does not parse. */
function parseState(text: string): Record<ScannerName, ToolState> {
    const parsed = JSON.parse(text) as Partial<Record<ScannerName, Partial<ToolState>>> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const version = (v: unknown): string | null => typeof v === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v) ? v : null
    const state = {} as Record<ScannerName, ToolState>
    for (const tool of TOOLS) {
        const saved = parsed[tool]
        const rejected = saved?.rejected
        state[tool] = {
            active: version(saved?.active),
            previous: version(saved?.previous),
            rejected: rejected && typeof rejected === 'object' && !Array.isArray(rejected) ? rejected : {},
        }
    }
    return state
}

/**
 * At boot: the newest downloaded binary that is newer than the image's and still says it is its
 * version when run. `broken` is the active one, when it had to be passed over for that.
 */
async function chooseAtBoot(
    tool: ScannerName,
    saved: ToolState,
    imageVersion: string,
    run: (version: string) => Promise<string>,
    log: Logger,
): Promise<{active: string | null, previous: string | null, broken: string | null}> {
    const beatsImage = (version: string | null): version is string => !!version && compareVersions(version, imageVersion) > 0
    let broken: string | null = null
    for (const version of [saved.active, saved.previous]) {
        if (!version) continue
        if (!beatsImage(version)) {
            log.info('image scanner is as new as the downloaded one; using the image\'s', {tool, image: imageVersion, downloaded: version})
            continue
        }
        try {
            const reported = await run(version)
            if (reported !== version) throw new Error(`reports version ${reported}`)
            if (version !== saved.active) log.warn('scanner rolled back at boot', {tool, from: saved.active, to: version})
            // A previous one no newer than the image's is no rollback target: the image's is.
            return {active: version, previous: version === saved.active && beatsImage(saved.previous) ? saved.previous : null, broken}
        } catch (e) {
            log.error('downloaded scanner unusable at boot', {tool, version, error: errorMessage(e)})
            if (version === saved.active) broken = version
        }
    }
    return {active: null, previous: null, broken}
}

/** Deletes every version folder in `dir` but those in `keep`. */
async function pruneVersions(dir: string, keep: (string | null)[], log: Logger): Promise<void> {
    await mkdir(dir, {recursive: true})
    for (const name of await readdir(dir)) {
        if (keep.includes(name)) continue
        await rm(join(dir, name), {recursive: true, force: true})
            .catch(e => log.warn('old scanner binary could not be removed', {dir, version: name, error: errorMessage(e)}))
    }
}

/** Records a refusal, newest last, keeping the last `MAX_REJECTED`. */
function remember(state: ToolState, version: string, rejection: Rejection): void {
    delete state.rejected[version]
    state.rejected[version] = rejection
    const names = Object.keys(state.rejected)
    for (const old of names.slice(0, Math.max(0, names.length - MAX_REJECTED))) delete state.rejected[old]
}
