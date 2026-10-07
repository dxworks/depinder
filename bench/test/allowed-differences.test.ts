import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterAll, describe, expect, it} from 'vitest'
import {DifferenceClassifier, webForm, type CellChange, type ReferenceFacts} from '../lib/allowed-differences.js'

// The D9 bucket: npm rows whose Component Link moved because core now follows the CLI's rule.

const dir = mkdtempSync(path.join(tmpdir(), 'bench-allowed-'))
afterAll(() => rmSync(dir, {recursive: true, force: true}))

const facts: ReferenceFacts = {startedAt: new Date('2026-10-01T00:00:00Z'), vulnDbsDiffer: false}
const HEADER = ['Component name', 'Component version name', 'Origin name', 'Component Link']

/** A kept cache holding the given libraries, as depinder's SQLite cache stores them. */
function cacheWith(libraries: Record<string, {reposUrl?: string[]}>): string {
    const file = path.join(dir, `cache-${Math.random().toString(36).slice(2)}.sqlite`)
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE libs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    const insert = db.prepare('INSERT INTO libs VALUES (?, ?, 0)')
    for (const [key, value] of Object.entries(libraries)) insert.run(key, JSON.stringify({versions: [], ...value}))
    db.close()
    return file
}

function classify(cacheFile: string, origin: string, changes: CellChange[]): string {
    const classifier = DifferenceClassifier.open(facts, cacheFile)
    try {
        return classifier.changedRow('_dependencies.csv', HEADER, ['unit-parser', '0.1.1', origin, 'x'], changes)
    } finally {
        classifier.close()
    }
}

const link = (a: string, b: string): CellChange => ({column: 'Component Link', a, b})
const OLDER_HOMEPAGE = 'https://github.com/o/unit-parser#readme'

describe('expected D9', () => {
    const cache = cacheWith({
        'npm:unit-parser': {},
        'npm:with-repo': {reposUrl: ['https://github.com/o/with-repo']},
    })

    it('labels a blank npm link that the older-version rule now fills', () => {
        expect(classify(cache, 'npmjs', [link('', OLDER_HOMEPAGE)])).toBe('expected-d9')
    })

    it('labels an npm link that was the repository and is now an older homepage', () => {
        const classifier = DifferenceClassifier.open(facts, cache)
        const row = ['with-repo', '1.0.0', 'npmjs', 'https://with-repo.example']
        expect(classifier.changedRow('_dependencies.csv', HEADER, row,
            [link('https://github.com/o/with-repo', 'https://with-repo.example')])).toBe('expected-d9')
        classifier.close()
    })

    it('leaves a link the pre-D9 server could not have written as a regression', () => {
        expect(classify(cache, 'npmjs', [link('https://elsewhere.example', OLDER_HOMEPAGE)])).toBe('regression')
    })

    it('is npm only', () => {
        expect(classify(cache, 'maven', [link('', OLDER_HOMEPAGE)])).toBe('regression')
    })

    it('needs the link to be the only change', () => {
        expect(classify(cache, 'npmjs', [link('', OLDER_HOMEPAGE), {column: 'License names', a: 'MIT', b: 'ISC'}]))
            .toBe('regression')
    })

    it('without B cache, counts any changed npm link', () => {
        expect(classify(path.join(dir, 'missing.sqlite'), 'npmjs', [link('https://elsewhere.example', OLDER_HOMEPAGE)]))
            .toBe('expected-d9')
    })
})

describe('webForm', () => {
    it('writes a clone URL as the export does', () => {
        expect(webForm('git+https://github.com/o/r.git')).toBe('https://github.com/o/r')
        expect(webForm('https://github.com/o/r')).toBe('https://github.com/o/r')
    })
})
