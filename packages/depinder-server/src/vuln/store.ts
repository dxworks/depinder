import {access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {errorMessage, type Logger} from '../shared/log.js'
import type {ScannerName} from './scanners.js'
import {describeBuild, type LeaseResult, type StaleHours} from './source.js'

/**
 * Managed mode's databases on disk: one folder per build, never written again once it is live.
 *
 *   VULN_DATA_DIR/
 *     trivy/<built-at>/db/{trivy.db,metadata.json}  + build.json
 *     grype/<built-at>/6/vulnerability.db           + build.json
 *     staging/<tool>-<random>/                       downloads land here
 *     current.json                                   {"trivy": "<folder>", "grype": "<folder>"}
 *
 * Installing is two renames and a pointer swap: the staging folder into place (same filesystem, so
 * atomic), `current.json.tmp` over `current.json`, then the in-memory pointer. Each scanner process
 * is handed its build's folder explicitly, so a scan that started on the old build keeps reading
 * the old files until it exits; no symlink, no file moved under a running scan.
 *
 * Every build counts the leases on it. A build that is no longer current is deleted the moment its
 * last lease is released — not kept as a "previous" build, which would mean ~9 GB on disk all the
 * time instead of ~4.4 GB for a rollback nobody would do unattended: nothing is installed without
 * passing the smoke test first.
 */

/** `build.json`, written into the staging folder before it goes live. */
export interface BuildRecord {
    tool: ScannerName
    /** As the database itself says: Trivy's `UpdatedAt`, Grype's `built`. */
    built_at: string
    schema: string
    /** The publisher's identity for it (`upstream.ts`). Null for a build seeded by hand. */
    upstream_id: string | null
    /** Findings on the canaries; the next build must reach 90 % of it. Null when never measured. */
    canary_findings: number | null
    installed_at: string
}

export interface CurrentBuild {
    folder: string
    /** What the scanner is pointed at. */
    dir: string
    record: BuildRecord
}

export interface StoreOpened {
    trivy?: BuildRecord
    grype?: BuildRecord
    /** Build folders that `current.json` did not reference, deleted. */
    removed: string[]
    /** `current.json` was there and did not parse; every build was dropped. */
    corrupt: boolean
}

export interface Store {
    readonly dataDir: string
    /** Boot: sweeps staging, reads `current.json`, verifies what it names, deletes the rest. */
    open(): Promise<StoreOpened>
    current(tool: ScannerName): CurrentBuild | undefined
    /** A fresh, empty folder under `staging/` for one download. */
    newStaging(tool: ScannerName): Promise<string>
    /** Makes the build in `stagingDir` current. The folder is moved; the caller must not touch it again. */
    install(tool: ScannerName, stagingDir: string, record: BuildRecord): Promise<{previous?: BuildRecord}>
    lease(): LeaseResult
    /** Every build still on disk: the current ones and those draining. */
    builds(): {tool: ScannerName, folder: string, refs: number, current: boolean}[]
    /** Resolves once the deletes already started are done. */
    settled(): Promise<void>
}

export const TOOLS: readonly ScannerName[] = ['trivy', 'grype']

/** What must be in a build folder for its scanner to read it. */
const REQUIRED_FILES: Record<ScannerName, string[]> = {
    trivy: [join('db', 'trivy.db'), join('db', 'metadata.json')],
    grype: [join('6', 'vulnerability.db')],
}

interface Entry {
    tool: ScannerName
    folder: string
    dir: string
    record: BuildRecord
    refs: number
    current: boolean
}

/** `2026-10-01T19:00:16.340316472Z` → `2026-10-01T190016.340316472Z`: no colons in a folder name. */
export function buildFolderName(builtAt: string): string {
    const name = builtAt.replace(/[^0-9A-Za-z.-]/g, '')
    if (!name || name.startsWith('.')) throw new Error(`cannot name a folder after built_at "${builtAt}"`)
    return name
}

export function createStore(options: {
    dataDir: string
    staleHours: StaleHours
    log: Logger
    now?: () => number
}): Store {
    const {dataDir, staleHours, log} = options
    const now = options.now ?? Date.now
    const stagingRoot = join(dataDir, 'staging')
    const currentFile = join(dataDir, 'current.json')

    const current: Partial<Record<ScannerName, Entry>> = {}
    const draining = new Set<Entry>()
    const deleting = new Set<Promise<void>>()

    const remove = (entry: Entry): void => {
        draining.delete(entry)
        const done = rm(entry.dir, {recursive: true, force: true}).then(
            () => log.info('database build removed', {tool: entry.tool, built_at: entry.record.built_at}),
            e => log.error('database build could not be removed', {tool: entry.tool, dir: entry.dir, error: errorMessage(e)}),
        ).finally(() => deleting.delete(done))
        deleting.add(done)
    }

    const writeCurrent = async (): Promise<void> => {
        const pointers: Partial<Record<ScannerName, string>> = {}
        for (const tool of TOOLS) {
            const entry = current[tool]
            if (entry) pointers[tool] = entry.folder
        }
        const tmp = `${currentFile}.tmp`
        await writeFile(tmp, JSON.stringify(pointers) + '\n')
        await rename(tmp, currentFile)
    }

    /** The build in `dir`, if it is whole: its `build.json` is this tool's and its files are there. */
    const verify = async (tool: ScannerName, folder: unknown): Promise<Entry | string> => {
        if (typeof folder !== 'string' || !folder || folder.includes('/') || folder.startsWith('.')) {
            return `not a folder name: ${JSON.stringify(folder)}`
        }
        const dir = join(dataDir, tool, folder)
        let record: BuildRecord
        try {
            record = JSON.parse(await readFile(join(dir, 'build.json'), 'utf8')) as BuildRecord
        } catch (e) {
            return `build.json unreadable: ${errorMessage(e)}`
        }
        if (record?.tool !== tool || typeof record.built_at !== 'string' || typeof record.schema !== 'string') {
            return 'build.json is not a build of this tool'
        }
        for (const file of REQUIRED_FILES[tool]) {
            try {
                await access(join(dir, file))
            } catch {
                return `${file} is missing`
            }
        }
        return {
            tool,
            folder,
            dir,
            record: {...record, upstream_id: record.upstream_id ?? null, canary_findings: record.canary_findings ?? null},
            refs: 0,
            current: true,
        }
    }

    return {
        dataDir,

        async open() {
            // A download that was running when the process stopped is worthless; start over.
            await rm(stagingRoot, {recursive: true, force: true})
            await mkdir(stagingRoot, {recursive: true})

            let pointers: Record<string, unknown> = {}
            let corrupt = false
            try {
                const parsed: unknown = JSON.parse(await readFile(currentFile, 'utf8'))
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
                pointers = parsed as Record<string, unknown>
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
                    corrupt = true
                    log.warn('current.json unreadable; starting with no builds', {error: errorMessage(e)})
                }
            }

            const opened: StoreOpened = {removed: [], corrupt}
            for (const tool of TOOLS) {
                if (pointers[tool] !== undefined) {
                    const entry = await verify(tool, pointers[tool])
                    if (typeof entry === 'string') {
                        log.warn('current build unusable; downloading a new one', {tool, folder: pointers[tool], reason: entry})
                    } else {
                        current[tool] = entry
                        opened[tool] = entry.record
                    }
                }
                // Anything else in the tool's folder is a crash leftover: an install that renamed
                // its build into place and died before `current.json` named it, or a build whose
                // delete was cut short.
                const toolDir = join(dataDir, tool)
                await mkdir(toolDir, {recursive: true})
                for (const name of await readdir(toolDir)) {
                    if (name === current[tool]?.folder) continue
                    await rm(join(toolDir, name), {recursive: true, force: true})
                    opened.removed.push(join(tool, name))
                }
            }
            // Say only what is really there, so the next boot does not trip over the same thing.
            if (corrupt || TOOLS.some(tool => pointers[tool] !== undefined && !current[tool])) await writeCurrent()
            return opened
        },

        current(tool) {
            const entry = current[tool]
            return entry && {folder: entry.folder, dir: entry.dir, record: entry.record}
        },

        async newStaging(tool) {
            await mkdir(stagingRoot, {recursive: true})
            return mkdtemp(join(stagingRoot, `${tool}-`))
        },

        async install(tool, stagingDir, record) {
            // Written while the folder is still staging: once live, nothing in it is written again.
            await writeFile(join(stagingDir, 'build.json'), JSON.stringify(record, null, 1) + '\n')
            const folder = buildFolderName(record.built_at)
            const dir = join(dataDir, tool, folder)
            await mkdir(join(dataDir, tool), {recursive: true})
            if (await access(dir).then(() => true, () => false)) throw new Error(`${dir} already exists`)
            await rename(stagingDir, dir)

            const entry: Entry = {tool, folder, dir, record, refs: 0, current: true}
            const previous = current[tool]
            current[tool] = entry
            try {
                await writeCurrent()
            } catch (e) {
                // The pointer on disk still names the old build: keep serving it, and let the next
                // boot's sweep or this delete take the new one away.
                if (previous) current[tool] = previous
                else delete current[tool]
                await rm(dir, {recursive: true, force: true})
                throw e
            }
            if (previous) {
                previous.current = false
                if (previous.refs === 0) remove(previous)
                else draining.add(previous)
            }
            return previous ? {previous: previous.record} : {}
        },

        lease() {
            const trivy = current.trivy
            const grype = current.grype
            if (!trivy || !grype) {
                return {ready: false, reason: TOOLS.filter(tool => !current[tool]).map(tool => `no ${tool} build yet`).join('; ')}
            }
            trivy.refs++
            grype.refs++
            let released = false
            const at = now()
            return {
                ready: true,
                trivy: describeBuild('trivy', trivy.dir, trivy.record, staleHours, at),
                grype: describeBuild('grype', grype.dir, grype.record, staleHours, at),
                release: () => {
                    if (released) return
                    released = true
                    for (const entry of [trivy, grype]) {
                        entry.refs--
                        if (!entry.current && entry.refs === 0) remove(entry)
                    }
                },
            }
        },

        builds() {
            const entries = [...TOOLS.map(tool => current[tool]).filter((it): it is Entry => !!it), ...draining]
            return entries.map(({tool, folder, refs, current: isCurrent}) => ({tool, folder, refs, current: isCurrent}))
        },

        async settled() {
            while (deleting.size > 0) await Promise.all(deleting)
        },
    }
}
