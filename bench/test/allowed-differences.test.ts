import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterAll, describe, expect, it} from 'vitest'
import {DifferenceClassifier, type CellChange, type ReferenceFacts} from '../lib/allowed-differences.js'

const dir = mkdtempSync(path.join(tmpdir(), 'bench-allowed-'))
afterAll(() => rmSync(dir, {recursive: true, force: true}))

const facts: ReferenceFacts = {startedAt: new Date('2026-10-01T00:00:00Z'), vulnDbsDiffer: false}
const AFTER_A_STARTED = Date.parse('2026-10-02T00:00:00Z')
const HEADER = ['Component name', 'Component version name', 'Origin name', 'Component Link']

/** A kept cache holding one npm library with a release after A started, as depinder's SQLite cache stores it. */
function cacheWithNewerRelease(name: string): string {
    const file = path.join(dir, `cache-${Math.random().toString(36).slice(2)}.sqlite`)
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE libs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    db.prepare('INSERT INTO libs VALUES (?, ?, 0)')
        .run(`npm:${name}`, JSON.stringify({versions: [{version: '2.0.0', timestamp: AFTER_A_STARTED}]}))
    db.close()
    return file
}

function classify(cacheFile: string, changes: CellChange[]): string {
    const classifier = DifferenceClassifier.open(facts, cacheFile)
    try {
        return classifier.changedRow('_dependencies.csv', HEADER, ['unit-parser', '0.1.1', 'npmjs', 'x'], changes)
    } finally {
        classifier.close()
    }
}

const link: CellChange = {column: 'Component Link', a: '', b: 'https://github.com/o/unit-parser#readme'}

describe('a changed npm Component Link', () => {
    it('is a regression, even when the library has a newer release', () => {
        expect(classify(cacheWithNewerRelease('unit-parser'), [link])).toBe('regression')
    })

    it('is a regression without B cache', () => {
        expect(classify(path.join(dir, 'missing.sqlite'), [link])).toBe('regression')
    })
})

describe('a newer release', () => {
    it('allows a moved Latest Version of a library released after A started', () => {
        const latest: CellChange = {column: 'Latest Version', a: '1.0.0', b: '2.0.0'}
        expect(classify(cacheWithNewerRelease('unit-parser'), [latest])).toBe('newer-release')
    })
})
