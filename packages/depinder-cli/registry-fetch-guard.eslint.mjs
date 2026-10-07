// The guard against the CLI fetching from a registry by itself (NX_MIGRATION.md phase 5): HTTP
// libraries and `fetch` only in the allow-listed clients, core's registry fetchers only in src/fallback.
import {readFileSync} from 'node:fs'

const guard = JSON.parse(readFileSync(new URL('./registry-fetch-guard.json', import.meta.url), 'utf8'))
const httpModulePattern = `^(${guard.httpModules.map(it => it.replace(/[.:/]/g, '\\$&')).join('|')})$`
const HTTP_MESSAGE = 'Registry data comes through src/fallback (core); only the allow-listed clients in registry-fetch-guard.json may make HTTP requests.'
const CORE_MESSAGE = 'Fetch registry data through src/fallback (createRegistryFallback), not core\'s fetchers directly.'

const bannedHttpImports = guard.httpModules.map(name => ({name, message: HTTP_MESSAGE}))
const bannedCoreFetchers = [{name: '@depinder/core', importNames: guard.coreRegistryFetchers, message: CORE_MESSAGE}]
const bannedHttpSyntax = [
    {selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']", message: HTTP_MESSAGE},
    {selector: "CallExpression[callee.property.name='fetch'][callee.object.name=/^(globalThis|global|window|self)$/]", message: HTTP_MESSAGE},
    {selector: `CallExpression[callee.name='require'][arguments.0.value=/${httpModulePattern}/]`, message: HTTP_MESSAGE},
    {selector: `ImportExpression[source.value=/${httpModulePattern}/]`, message: HTTP_MESSAGE},
]

/** Later entries win: src/fallback may use core's fetchers, the allow-listed clients may use HTTP. */
export function registryFetchGuardConfig(files) {
    return [
        {
            files,
            rules: {
                'no-restricted-imports': ['error', {paths: [...bannedHttpImports, ...bannedCoreFetchers]}],
                'no-restricted-syntax': ['error', ...bannedHttpSyntax],
            },
        },
        {
            files: guard.registryFetchFiles,
            rules: {'no-restricted-imports': ['error', {paths: bannedHttpImports}]},
        },
        {
            files: guard.httpClientFiles,
            rules: {
                'no-restricted-imports': ['error', {paths: bannedCoreFetchers}],
                'no-restricted-syntax': 'off',
            },
        },
    ]
}
