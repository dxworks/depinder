import {readdirSync, readFileSync} from 'node:fs'
import {builtinModules} from 'node:module'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// What core may hold, checked: only what both the CLI and the server use (no feeds, polls,
// database or fetch_log), imports of nothing but itself, Node and its declared dependencies, code
// the CLI can bundle, and the size ceilings of the root CLAUDE.md.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_SRC_LINES = 400
const MAX_TEST_LINES = 550
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Paths relative to core, with `/`, of the `.ts` files under `dir`, fixtures left out. */
function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(join(ROOT, dir), {withFileTypes: true})) {
        const path = `${dir}/${entry.name}`
        if (entry.name === 'fixtures') continue
        if (entry.isDirectory()) out.push(...walk(path))
        else if (entry.name.endsWith('.ts')) out.push(path)
    }
    return out.sort()
}

const read = (file: string) => readFileSync(join(ROOT, file), 'utf8')
const lineCount = (file: string) => read(file).split('\n').length - (read(file).endsWith('\n') ? 1 : 0)
const src = walk('src')

/** The files whose text matches `pattern`, as "file: match". */
function matching(files: string[], pattern: RegExp): string[] {
    return files.flatMap(file => [...read(file).matchAll(pattern)].map(m => `${file}: ${m[0].trim()}`))
}

describe('core architecture', () => {
    it('holds no feed, poll, database or fetch_log code', () => {
        const serverOnly = /\b(FeedSpec|FeedResult|PollTarget|PollResult|initialCursor|fetch_log|FetchRecord)\b|\b(insert into|select \*|pg_notify)\b/gi
        expect(matching(src, serverOnly)).toEqual([])
    })

    it('imports only itself, Node and the dependencies it declares', () => {
        const declared = Object.keys(JSON.parse(read('package.json')).dependencies ?? {})
        const allowed = (specifier: string) =>
            specifier.startsWith('.') ||
            specifier.startsWith('node:') ||
            builtinModules.includes(specifier) ||
            declared.some(name => specifier === name || specifier.startsWith(`${name}/`))
        const imports = src.flatMap(file => [...read(file).matchAll(SPECIFIER)].map(m => ({file, specifier: m[1]!})))
        expect(imports.length).toBeGreaterThan(0)
        expect(imports.filter(i => !allowed(i.specifier)).map(i => `${i.file} -> ${i.specifier}`)).toEqual([])
    })

    it('is bundleable by the CLI: no top-level await, no import.meta in its sources', () => {
        expect(matching(src, /^await\b|import\.meta/gm)).toEqual([])
    })
})

describe('core file sizes', () => {
    const oversized = (files: string[], max: number) =>
        files.filter(file => lineCount(file) > max).map(file => `${file} (${lineCount(file)})`)

    it(`keeps every src/ file within ${MAX_SRC_LINES} lines`, () => {
        expect(oversized(src, MAX_SRC_LINES)).toEqual([])
    })

    it(`keeps every test/ file within ${MAX_TEST_LINES} lines (fixtures exempt)`, () => {
        expect(oversized(walk('test'), MAX_TEST_LINES)).toEqual([])
    })
})
