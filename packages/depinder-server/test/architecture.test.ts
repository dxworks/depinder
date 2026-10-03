import {readdirSync, readFileSync} from 'node:fs'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// The layout rule and the size ceilings from CLAUDE.md, checked. The ceilings sit a little above
// the soft targets (code ~350 lines, tests ~500), so ordinary growth does not trip them.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_SRC_LINES = 400
const MAX_TEST_LINES = 550
const CODE = /\.(ts|cjs|mjs|js)$/
// `from '…'`, `import '…'`, `import('…')`, `require('…')`; `export … from` is covered by `from`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Repo-relative paths, with `/`, of the files under `dir` that match `pattern`. */
function walk(dir: string, pattern: RegExp, skip: string[] = []): string[] {
    const out: string[] = []
    for (const entry of readdirSync(join(ROOT, dir), {withFileTypes: true})) {
        const path = `${dir}/${entry.name}`
        if (skip.includes(path) || entry.name === 'node_modules') continue
        if (entry.isDirectory()) out.push(...walk(path, pattern, skip))
        else if (pattern.test(entry.name)) out.push(path)
    }
    return out.sort()
}

/** The relative imports of `file`, resolved to repo-relative paths. Packages are left out. */
function relativeImports(file: string): {specifier: string; target: string}[] {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const out: {specifier: string; target: string}[] = []
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
        if (!specifier.startsWith('.')) continue
        const target = relative(ROOT, resolve(ROOT, dirname(file), specifier)).split(sep).join('/')
        out.push({specifier, target})
    }
    return out
}

function lineCount(file: string): number {
    const text = readFileSync(join(ROOT, file), 'utf8')
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** Every import from a file in `from` into one of `forbidden`, as "file -> specifier". */
function violations(
    from: string[],
    forbidden: string[],
    allowed: (file: string, target: string) => boolean = () => false,
): string[] {
    return from.flatMap((file) =>
        relativeImports(file)
            .filter(({target}) => forbidden.some((dir) => under(target, dir)) && !allowed(file, target))
            .map(({specifier}) => `${file} -> ${specifier}`),
    )
}

describe('architecture', () => {
    const src = walk('src', /\.ts$/)
    const bench = walk('bench', CODE, ['bench/runs'])

    it('sees the imports it is meant to police', () => {
        // Guards against a parser that silently finds nothing.
        expect(relativeImports('src/vuln/server.ts').map((i) => i.target)).toContain('src/shared/http-server.js')
        expect(relativeImports('bench/micro/vuln-parity.ts').map((i) => i.target)).toContain('src/vuln/merge/index.js')
    })

    it('keeps src/vuln free of src/resolver', () => {
        expect(violations(src.filter((f) => under(f, 'src/vuln')), ['src/resolver'])).toEqual([])
    })

    it('keeps src/shared free of src/resolver and src/vuln', () => {
        expect(violations(src.filter((f) => under(f, 'src/shared')), ['src/resolver', 'src/vuln'])).toEqual([])
    })

    it('keeps bench/ out of src/, except the vuln parity check on the merge', () => {
        const allowed = (file: string, target: string) =>
            file === 'bench/micro/vuln-parity.ts' && under(target, 'src/vuln/merge')
        expect(violations(bench, ['src'], allowed)).toEqual([])
    })
})

/** The files over `max` lines, as "file (lines)". */
function oversized(files: string[], max: number): string[] {
    return files.map((file) => ({file, lines: lineCount(file)}))
        .filter(({lines}) => lines > max)
        .map(({file, lines}) => `${file} (${lines})`)
}

describe('file sizes', () => {
    it(`keeps every src/ file within ${MAX_SRC_LINES} lines`, () => {
        expect(oversized(walk('src', /\.ts$/), MAX_SRC_LINES)).toEqual([])
    })

    it(`keeps every test/ file within ${MAX_TEST_LINES} lines (fixtures exempt)`, () => {
        expect(oversized(walk('test', CODE, ['test/fixtures']), MAX_TEST_LINES)).toEqual([])
    })
})
