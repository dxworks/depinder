import {readdirSync, readFileSync} from 'node:fs'
import {dirname, join, relative, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

// The server's import rule, checked: `shared` <- `resolver`, `shared` <- `vuln`, never `vuln` ->
// `resolver`. Nx tags do not police folders inside one project.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// `from '…'`, `import '…'`, `import('…')`, `require('…')`; `export … from` is covered by `from`.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

/** Repo-relative paths, with `/`, of the files under `dir` that match `pattern`. */
function walk(dir: string, pattern: RegExp): string[] {
    const out: string[] = []
    for (const entry of readdirSync(join(ROOT, dir), {withFileTypes: true})) {
        const path = `${dir}/${entry.name}`
        if (entry.name === 'node_modules') continue
        if (entry.isDirectory()) out.push(...walk(path, pattern))
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

const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)

/** Every import from a file in `from` into one of `forbidden`, as "file -> specifier". */
function violations(from: string[], forbidden: string[]): string[] {
    return from.flatMap((file) =>
        relativeImports(file)
            .filter(({target}) => forbidden.some((dir) => under(target, dir)))
            .map(({specifier}) => `${file} -> ${specifier}`),
    )
}

describe('architecture', () => {
    const src = walk('src', /\.ts$/)

    it('sees the imports it is meant to police', () => {
        // Guards against a parser that silently finds nothing.
        expect(relativeImports('src/vuln/server.ts').map((i) => i.target)).toContain('src/shared/http-server.js')
    })

    it('keeps src/vuln free of src/resolver', () => {
        expect(violations(src.filter((f) => under(f, 'src/vuln')), ['src/resolver'])).toEqual([])
    })

    it('keeps src/shared free of src/resolver and src/vuln', () => {
        expect(violations(src.filter((f) => under(f, 'src/shared')), ['src/resolver', 'src/vuln'])).toEqual([])
    })
})
