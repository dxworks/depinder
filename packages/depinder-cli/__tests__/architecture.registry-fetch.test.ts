import fs from 'fs'
import path from 'path'
import {minimatch} from 'minimatch'
import guard from '../registry-fetch-guard.json'

/**
 * The CLI never fetches from a package registry by itself: registry data comes through core, from
 * src/fallback. Only the allow-listed clients (resolver, vulnerability server, GitHub advisories,
 * Libraries.io) make HTTP requests. The lint rule says the same; this holds even past an
 * `eslint-disable`.
 */

const CLI_ROOT = path.join(__dirname, '..')

function sourceFiles(dir = path.join(CLI_ROOT, 'src')): string[] {
    return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return sourceFiles(full)
        return entry.name.endsWith('.ts') ? [path.relative(CLI_ROOT, full).split(path.sep).join('/')] : []
    })
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const HTTP_MODULE = new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"](${guard.httpModules.map(escape).join('|')})['"]`)
const FETCH_CALL = /(?:^|[^\w.$]|\b(?:globalThis|global|window|self)\.)fetch\s*\(/m
const REGISTRY_HOST = new RegExp(`(?://|['"\`])(?:[\\w-]+\\.)*(${guard.registryHosts.map(escape).join('|')})\\b`)
const CORE_FETCHER_IMPORT = new RegExp(`import\\s*\\{[^}]*\\b(${guard.coreRegistryFetchers.join('|')})\\b[^}]*\\}\\s*from\\s*['"]@depinder/core['"]`)

/** Comments may name registries; only code counts. */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

const matchesAny = (file: string, globs: string[]) => globs.some(glob => minimatch(file, glob))
const files = sourceFiles().map(file => ({file, code: withoutComments(fs.readFileSync(path.join(CLI_ROOT, file), 'utf8'))}))

describe('the CLI fetches registry data only through core', () => {
    it('finds the source files', () => {
        expect(files.length).toBeGreaterThan(50)
        expect(files.map(it => it.file)).toContain('src/fallback/registry-fallback.ts')
    })

    it('makes HTTP requests only from the allow-listed clients', () => {
        const offenders = files
            .filter(({file, code}) => !matchesAny(file, guard.httpClientFiles) && (HTTP_MODULE.test(code) || FETCH_CALL.test(code)))
            .map(it => it.file)
        expect(offenders).toEqual([])
    })

    it('names no package registry host', () => {
        const offenders = files.filter(({code}) => REGISTRY_HOST.test(code)).map(({file, code}) => `${file}: ${code.match(REGISTRY_HOST)?.[0]}`)
        expect(offenders).toEqual([])
    })

    it('uses core\'s registry fetchers only in src/fallback', () => {
        const offenders = files
            .filter(({file, code}) => !matchesAny(file, guard.registryFetchFiles) && CORE_FETCHER_IMPORT.test(code))
            .map(it => it.file)
        expect(offenders).toEqual([])
    })
})

describe('the registry fetch detectors', () => {
    it.each([
        ['import axios from \'axios\''],
        ['const fetch = require("node-fetch")'],
        ['import {json} from \'npm-registry-fetch\''],
        ['import https from \'node:https\''],
    ])('see an HTTP library in %s', code => expect(HTTP_MODULE.test(code)).toBe(true))

    it.each([['await fetch(url)'], ['globalThis.fetch(url)'], ['x = fetch (url)']])('see a fetch call in %s', code => {
        expect(FETCH_CALL.test(code)).toBe(true)
    })

    it('do not take a method or a word ending in fetch for a fetch call', () => {
        expect(FETCH_CALL.test('this.fetch(url); prefetch(x); fetchLibraryInfo(pkg)')).toBe(false)
    })

    it.each([
        ['`https://registry.npmjs.org/${name}`'],
        ['\'https://repo1.maven.org/maven2\''],
        ['"https://pypi.org/pypi"'],
        ['`https://index.crates.io/x`'],
        ['\'api.nuget.org\''],
    ])('see a registry host in %s', code => expect(REGISTRY_HOST.test(code)).toBe(true))

    it('ignore a registry named in a comment', () => {
        expect(REGISTRY_HOST.test(withoutComments('// crates.io\'s pre-SPDX shorthand\n/** https://pypi.org */'))).toBe(false)
    })

    it('see core\'s fetchers imported', () => {
        expect(CORE_FETCHER_IMPORT.test('import {canFetch, fetchPackage} from \'@depinder/core\'')).toBe(true)
        expect(CORE_FETCHER_IMPORT.test('import {type PackageRecord} from \'@depinder/core\'')).toBe(false)
    })
})
