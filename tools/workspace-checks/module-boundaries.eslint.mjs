// The import rules between projects (NX_MIGRATION.md section 3), enforced by Nx from the project
// tags: core imports only core; the CLI and the server import core, never each other; only the
// parity tests import all three; the bench and the tooling import no project.
import nx from '@nx/eslint-plugin'
import tseslint from 'typescript-eslint'

export const DEP_CONSTRAINTS = [
    {sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared']},
    {sourceTag: 'scope:client', onlyDependOnLibsWithTags: ['scope:shared', 'scope:client']},
    {sourceTag: 'scope:server', onlyDependOnLibsWithTags: ['scope:shared', 'scope:server']},
    {sourceTag: 'scope:test', onlyDependOnLibsWithTags: ['scope:shared', 'scope:client', 'scope:server', 'scope:test']},
    {sourceTag: 'scope:bench', onlyDependOnLibsWithTags: ['scope:bench']},
    {sourceTag: 'scope:tooling', onlyDependOnLibsWithTags: ['scope:tooling']},
]

/**
 * `files` are globs relative to the project folder that lints them. `appImports` are the import
 * paths of an app this project may use anyway; Nx forbids importing apps, and only parity may.
 */
export function moduleBoundariesConfig(files, appImports = []) {
    return [
        {
            files,
            languageOptions: {parser: tseslint.parser},
            plugins: {'@nx': nx},
            rules: {
                '@nx/enforce-module-boundaries': [
                    'error',
                    {enforceBuildableLibDependency: false, allow: appImports, depConstraints: DEP_CONSTRAINTS},
                ],
            },
        },
    ]
}
