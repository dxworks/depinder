import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'
import {KeptCache} from './kept-cache.js'
import {newerRecommendations, recommendedVersionColumnOf} from './upgrade-guidance.js'

/**
 * Sorts the CSV differences between a reference run (A) and a later run (B) by the regression
 * rules of NX_MIGRATION.md (section 6):
 *
 * - `newer-release`: the row's library has a version that B's cache dates after A started, and the
 *   row differs only in columns a newer release moves (latest version and its date, Newer
 *   Versions, the risk built on them, a Black Duck upgrade recommendation that is such a version
 *   and the columns that follow it). An ecosystem's project stats follow when it has such rows,
 *   its license list when such rows changed a library's licenses.
 * - `vuln-db`: a vulnerability column or file, when A and B scanned with different database builds.
 * - `expected-d9`: an npm row that differs only in Component Link, where A's link is what the
 *   server gave a package without a top-level homepage before D9 (blank, or its repository). Neither
 *   allowed nor a regression: it needs Alex's sign-off.
 * - `regression`: everything else.
 */

export type DiffClass = 'newer-release' | 'vuln-db' | 'expected-d9' | 'regression'
export const DIFF_CLASSES: readonly DiffClass[] = ['regression', 'expected-d9', 'newer-release', 'vuln-db']

/** One differing cell of a row present in both runs. */
export interface CellChange {
    column: string
    a: string
    b: string
}

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
const DEPENDENCIES_FILE = '_dependencies.csv'
const COMPONENT_LINK = 'Component Link'

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

/**
 * Classifies the differences of one folder pair. Row files must be classified before summary
 * files (see `isSummaryFile`), since a summary follows its ecosystem's rows.
 */
export class DifferenceClassifier {
    private readonly ecosystemsWithNewerReleases = new Set<string>()
    private readonly ecosystemsWithNewerReleaseLicenses = new Set<string>()

    constructor(private readonly facts: ReferenceFacts | null, private readonly cacheB: KeptCache | null) {}

    /** `cacheFileB` is B's SQLite cache for this cell; without it no row can count as a newer release. */
    static open(facts: ReferenceFacts | null, cacheFileB: string): DifferenceClassifier {
        const cacheB = facts && existsSync(cacheFileB) ? new KeptCache(cacheFileB, facts.startedAt.getTime()) : null
        return new DifferenceClassifier(facts, cacheB)
    }

    /** Without B's cache no row is a newer release, and an npm link change counts as D9 on its ecosystem alone. */
    get canTellNewerReleases(): boolean {
        return this.cacheB !== null
    }

    /** A row present in one run only. */
    missingRow(file: string): DiffClass {
        return this.facts?.vulnDbsDiffer && VULN_FILES.has(path.basename(file)) ? 'vuln-db' : 'regression'
    }

    /** A row present in both runs; `header` and `row` are B's. */
    changedRow(file: string, header: string[], row: string[], changes: CellChange[]): DiffClass {
        const base = path.basename(file)
        const columns = changes.map(c => c.column)
        if (this.facts?.vulnDbsDiffer && (VULN_FILES.has(base) || columns.every(c => VULN_COLUMN.test(c)))) return 'vuln-db'
        const summary = base.match(SUMMARY_FILE)
        if (summary) {
            const followed = summary[2] === 'licenses' ? this.ecosystemsWithNewerReleaseLicenses : this.ecosystemsWithNewerReleases
            return followed.has(summary[1]) ? 'newer-release' : 'regression'
        }
        const library = libraryOf(base, header, row)
        const newerRecommended = library
            ? newerRecommendations(base, changes, version => !!this.cacheB?.isReleasedAfterCutoff(library.ecosystems, library.name, version))
            : new Set<string>()
        const allowed = columns.every(c => NEWER_RELEASE_COLUMNS.has(c)
            || (c === LATEST_VERSION_LICENSES && columns.includes('Latest Version'))
            || newerRecommended.has(recommendedVersionColumnOf(base, c) ?? '')
            || (this.facts?.vulnDbsDiffer && VULN_COLUMN.test(c)))
        if (library && this.isExpectedD9(base, library, changes)) return 'expected-d9'
        if (!allowed || !library || !this.cacheB?.hasReleaseAfterCutoff(library.ecosystems, library.name)) return 'regression'
        for (const eco of library.ecosystems) {
            this.ecosystemsWithNewerReleases.add(eco)
            if (columns.includes(LATEST_VERSION_LICENSES)) this.ecosystemsWithNewerReleaseLicenses.add(eco)
        }
        return 'newer-release'
    }

    /**
     * D9: only the npm Component Link moved, and A's link is the pre-D9 answer for a package with
     * no top-level homepage, i.e. blank or its repository (from B's cache). Without the cache, any
     * changed npm link counts.
     */
    private isExpectedD9(file: string, library: Library, changes: CellChange[]): boolean {
        const [change] = changes
        if (file !== DEPENDENCIES_FILE || changes.length !== 1 || change?.column !== COMPONENT_LINK) return false
        if (library.ecosystems.length !== 1 || library.ecosystems[0] !== 'npm') return false
        if (!this.cacheB) return true
        const repository = this.cacheB.repositoryOf('npm', library.name)
        return repository !== undefined && ['', webForm(repository)].includes(webForm(change.a))
    }

    close(): void {
        this.cacheB?.close()
    }
}

/** A repository URL as the export's Component Link writes it (the CLI's `canonicalProjectUrl`, in short). */
export function webForm(url: string): string {
    return url.trim().replace(/^git\+/, '').replace(/\.git(?=$|[#?])/, '')
}

interface Library {
    ecosystems: string[]
    name: string
}

export const isSummaryFile = (file: string): boolean => SUMMARY_FILE.test(path.basename(file))

function libraryOf(file: string, header: string[], row: string[]): Library | null {
    const cell = (column: string) => {
        const i = header.indexOf(column)
        return i < 0 ? '' : row[i] ?? ''
    }
    const libs = file.match(LIBS_FILE)
    if (libs) return cell('Library') ? {ecosystems: [libs[1]], name: cell('Library')} : null
    const name = cell('Component name') || cell('Component Name')
    if (!name) return null
    const eco = ORIGIN_ECOSYSTEMS[cell('Origin name') || cell('Component Origin Name')]
    return {ecosystems: eco ? [eco] : ECOSYSTEMS, name}
}
