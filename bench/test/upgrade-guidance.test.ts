import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {afterAll, describe, expect, it} from 'vitest'
import {DifferenceClassifier, type CellChange, type ReferenceFacts} from '../lib/allowed-differences.js'

// A Black Duck upgrade recommendation that moved to a version released after the reference run.

const dir = mkdtempSync(path.join(tmpdir(), 'bench-upgrade-'))
afterAll(() => rmSync(dir, {recursive: true, force: true}))

const facts: ReferenceFacts = {startedAt: new Date('2026-10-03T10:00:00Z'), vulnDbsDiffer: false}
const HEADER = ['Component Name', 'Component Version Name', 'Component Origin Name', 'Component Version Origin Id']
const ROW = ['nodemailer', '8.0.10', 'npmjs', 'nodemailer/8.0.10']

const cacheFile = (() => {
    const file = path.join(dir, 'cache.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE libs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)')
    db.prepare('INSERT INTO libs VALUES (?, ?, 0)').run('npm:nodemailer', JSON.stringify({versions: [
        {version: '10.0.13', timestamp: Date.parse('2026-09-30T04:40:23Z')},
        {version: '10.0.14', timestamp: Date.parse('2026-10-03T13:45:29Z')},
    ]}))
    db.close()
    return file
})()

function classify(changes: CellChange[], file = '_upgrade_guidance.csv'): string {
    const classifier = DifferenceClassifier.open(facts, cacheFile)
    try {
        return classifier.changedRow(file, HEADER, ROW, changes)
    } finally {
        classifier.close()
    }
}

const change = (column: string, a: string, b: string): CellChange => ({column, a, b})
const longTermTo = (version: string): CellChange[] => [
    change('Long Term Recommended Version Name', '10.0.13', version),
    change('Long Term Recommended Origin Id', 'nodemailer/10.0.13', `nodemailer/${version}`),
    change('Long Term Recommended Origin Version Name', '10.0.13', version),
]

describe('upgrade guidance', () => {
    it('counts a recommendation moved to a newer release, with the columns that follow it', () => {
        expect(classify(longTermTo('10.0.14'))).toBe('newer-release')
        expect(classify([...longTermTo('10.0.14'), change('Long Term High Vulnerability', '0', '1')])).toBe('newer-release')
    })

    it('flags a recommendation moved to a version released before the reference run', () => {
        expect(classify(longTermTo('10.0.12'))).toBe('regression')
    })

    it('flags a recommendation moved to a version the cache does not know', () => {
        expect(classify(longTermTo('11.0.0'))).toBe('regression')
    })

    it('flags following columns that moved without their recommended version', () => {
        expect(classify(longTermTo('10.0.14').slice(1))).toBe('regression')
        expect(classify([change('Short Term High Vulnerability', '0', '1')])).toBe('regression')
    })

    it('does not let one term\'s newer release excuse the other term', () => {
        expect(classify([...longTermTo('10.0.14'), change('Short Term Recommended Origin Id', 'nodemailer/10.0.6', 'nodemailer/10.0.7')]))
            .toBe('regression')
    })

    it('flags a changed recommended origin name', () => {
        expect(classify([...longTermTo('10.0.14'), change('Long Term Recommended Origin Name', 'npmjs', 'github')])).toBe('regression')
    })

    it('applies only to the upgrade guidance file', () => {
        expect(classify(longTermTo('10.0.14'), '_dependencies.csv')).toBe('regression')
    })
})
