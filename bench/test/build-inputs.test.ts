import {mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {CLI_BUNDLE_INPUTS, newestFile, serverImageInputs} from '../lib/build-inputs.js'
import {MONOREPO_DIR} from '../lib/targets.js'

// What the staleness checks compare the server image and the CLI's dist/ against.

describe("the artefacts' inputs", () => {
    it('include core for both artefacts', () => {
        expect(serverImageInputs()).toEqual(expect.arrayContaining([
            'packages/depinder-core/src', 'packages/depinder-server/src', 'package-lock.json', 'packages/depinder-server/Dockerfile',
        ]))
        expect(CLI_BUNDLE_INPUTS).toEqual(expect.arrayContaining(['packages/depinder-core/src', 'packages/depinder-cli/src']))
    })

    it('all exist in the monorepo', () => {
        for (const input of [...serverImageInputs(), ...CLI_BUNDLE_INPUTS]) {
            expect(newestFile([input], MONOREPO_DIR), input).not.toBeNull()
        }
    })
})

describe('newestFile', () => {
    let root: string
    const touch = (relative: string, seconds: number) => {
        const full = path.join(root, relative)
        mkdirSync(path.dirname(full), {recursive: true})
        writeFileSync(full, '')
        utimesSync(full, seconds, seconds)
    }

    beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'bench-build-inputs-')) })
    afterEach(() => rmSync(root, {recursive: true, force: true}))

    it('finds the newest file across folders and single files, skipping missing inputs', () => {
        touch('core/src/purl.ts', 3_000)
        touch('cli/src/deep/analyse.ts', 2_000)
        touch('package-lock.json', 1_000)
        const newest = newestFile(['cli/src', 'core/src', 'package-lock.json', 'missing'], root)
        expect(newest).toEqual({path: path.join('core', 'src', 'purl.ts'), mtimeMs: 3_000_000})
    })

    it('is null when no input exists', () => {
        expect(newestFile(['missing'], root)).toBeNull()
    })
})
