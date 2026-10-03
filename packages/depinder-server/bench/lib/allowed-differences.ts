import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'

/**
 * Sorts the CSV differences between a reference run (A) and a later run (B) by the regression
 * rules of NX_MIGRATION.md (section 6):
 *
 * - `newer-release`: the row's library has a version that B's cache dates after A started, and the
 *   row differs only in columns a newer release moves (latest version and its date, Newer
 *   Versions, the risk built on them). An ecosystem's project stats follow when it has such rows,
 *   its license list when such rows changed a library's licenses.
 * - `vuln-db`: a vulnerability column or file, when A and B scanned with different database builds.
 * - `regression`: everything else.
 */

export type DiffClass = 'newer-release' | 'vuln-db' | 'regression'
export const DIFF_CLASSES: readonly DiffClass[] = ['regression', 'newer-release', 'vuln-db']

const NEWER_RELEASE_COLUMNS = new Set([
    'Latest Version', 'Latest Version Release Date', 'Latest-Used', 'Now-latest',
    'Newer Versions', 'Newer Versions (semver)', 'Operational Risk',
])
/** The library's licenses follow its latest version, so they may move with a new latest version. */
const LATEST_VERSION_LICENSES = 'Licenses'

const VULN_FILES = new Set(['security.csv', '_vulnerability_details.csv', '_upgrade_guidance.csv'])
const VULN_COLUMN = /vulnerab|security risk/i

const SUMMARY_FILE = /^sbom-(\w+)-(project-stats|licenses)\.csv$/
const LIBS_FILE = /^sbom-(\w+)-libs\.csv$/

/** Black Duck origin names → depinder's cache ecosystems; unknown origins search every ecosystem. */
const ORIGIN_ECOSYSTEMS: Readonly<Record<string, string>> = {
    npmjs: 'npm', maven: 'java', nuget: 'dotnet', pypi: 'python', rubygems: 'ruby',
    crates: 'rust', packagist: 'php', github: 'go', golang: 'go',
}
const ECOSYSTEMS = ['npm', 'java', 'dotnet', 'python', 'ruby', 'rust', 'php', 'go']

export interface ReferenceFacts {
    /** When the reference run (A) started: releases after this are "newer". */
    startedAt: Date
    vulnDbsDiffer: boolean
}

/** A's start and whether both runs scanned with the same vulnerability database builds. */
export function referenceFacts(runDirA: string, runDirB: string): ReferenceFacts | null {
    const runA = readRunJson(runDirA)
    const runB = readRunJson(runDirB)
    if (!runA?.startedAt) return null
    const builds = (run: RunJson | null) => JSON.stringify(Object.entries(run?.vulnHealth?.databases ?? {})
        .map(([name, db]) => [name, db.built_at]).sort())
    return {startedAt: new Date(runA.startedAt), vulnDbsDiffer: builds(runA) !== builds(runB)}
}

interface RunJson {
    startedAt?: string
    vulnHealth?: {databases?: Record<string, {built_at?: string}>}
}

function readRunJson(dir: string): RunJson | null {
    const file = path.join(dir, 'run.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as RunJson : null
}

/** Release dates from B's kept SQLite cache (`--keep-caches`), looked up once per library. */
class ReleaseDates {
    private readonly db: DatabaseSync
    private readonly memo = new Map<string, boolean>()

    constructor(cacheFile: string, private readonly cutoffMs: number) {
        this.db = new DatabaseSync(cacheFile, {readOnly: true})
    }

    /** Whether any version of the library was published after the cutoff. */
    hasReleaseAfterCutoff(ecosystems: readonly string[], name: string): boolean {
        const memoKey = `${ecosystems.join(',')}|${name}`
        const known = this.memo.get(memoKey)
        if (known !== undefined) return known
        const found = ecosystems.some(eco => [name, name.toLowerCase()].some(n => this.releasedAfter(`${eco}:${n}`)))
        this.memo.set(memoKey, found)
        return found
    }

    private releasedAfter(key: string): boolean {
        const row = this.db.prepare('SELECT value FROM libs WHERE key = ?').get(key) as {value: string} | undefined
        if (!row) return false
        const versions = (JSON.parse(row.value) as {versions?: {timestamp?: number}[]}).versions ?? []
        return versions.some(v => (v.timestamp ?? 0) > this.cutoffMs)
    }

    close(): void {
        this.db.close()
    }
}

/**
 * Classifies the differences of one folder pair. Row files must be classified before summary
 * files (see `isSummaryFile`), since a summary follows its ecosystem's rows.
 */
export class DifferenceClassifier {
    private readonly ecosystemsWithNewerReleases = new Set<string>()
    private readonly ecosystemsWithNewerReleaseLicenses = new Set<string>()

    constructor(private readonly facts: ReferenceFacts | null, private readonly releases: ReleaseDates | null) {}

    /** `cacheFileB` is B's SQLite cache for this cell; without it no row can count as a newer release. */
    static open(facts: ReferenceFacts | null, cacheFileB: string): DifferenceClassifier {
        const releases = facts && existsSync(cacheFileB) ? new ReleaseDates(cacheFileB, facts.startedAt.getTime()) : null
        return new DifferenceClassifier(facts, releases)
    }

    get canTellNewerReleases(): boolean {
        return this.releases !== null
    }

    /** A row present in one run only. */
    missingRow(file: string): DiffClass {
        return this.facts?.vulnDbsDiffer && VULN_FILES.has(path.basename(file)) ? 'vuln-db' : 'regression'
    }

    /** A row present in both runs whose `columns` differ. */
    changedRow(file: string, header: string[], row: string[], columns: string[]): DiffClass {
        const base = path.basename(file)
        if (this.facts?.vulnDbsDiffer && (VULN_FILES.has(base) || columns.every(c => VULN_COLUMN.test(c)))) return 'vuln-db'
        const summary = base.match(SUMMARY_FILE)
        if (summary) {
            const followed = summary[2] === 'licenses' ? this.ecosystemsWithNewerReleaseLicenses : this.ecosystemsWithNewerReleases
            return followed.has(summary[1]) ? 'newer-release' : 'regression'
        }
        const allowed = columns.every(c => NEWER_RELEASE_COLUMNS.has(c)
            || (c === LATEST_VERSION_LICENSES && columns.includes('Latest Version'))
            || (this.facts?.vulnDbsDiffer && VULN_COLUMN.test(c)))
        const library = libraryOf(base, header, row)
        if (!allowed || !library || !this.releases?.hasReleaseAfterCutoff(library.ecosystems, library.name)) return 'regression'
        for (const eco of library.ecosystems) {
            this.ecosystemsWithNewerReleases.add(eco)
            if (columns.includes(LATEST_VERSION_LICENSES)) this.ecosystemsWithNewerReleaseLicenses.add(eco)
        }
        return 'newer-release'
    }

    close(): void {
        this.releases?.close()
    }
}

export const isSummaryFile = (file: string): boolean => SUMMARY_FILE.test(path.basename(file))

function libraryOf(file: string, header: string[], row: string[]): {ecosystems: string[], name: string} | null {
    const cell = (column: string) => {
        const i = header.indexOf(column)
        return i < 0 ? '' : row[i] ?? ''
    }
    const libs = file.match(LIBS_FILE)
    if (libs) return cell('Library') ? {ecosystems: [libs[1]], name: cell('Library')} : null
    const name = cell('Component name') || cell('Component Name')
    if (!name) return null
    const eco = ORIGIN_ECOSYSTEMS[cell('Origin name')]
    return {ecosystems: eco ? [eco] : ECOSYSTEMS, name}
}
