// The import rules between projects, enforced by Nx from the project tags: core imports only core;
// the CLI and the server import core, never each other; the tooling imports no project.
import nx from '@nx/eslint-plugin'
import tseslint from 'typescript-eslint'

const DEP_CONSTRAINTS = [
    {sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared']},
    {sourceTag: 'scope:client', onlyDependOnLibsWithTags: ['scope:shared', 'scope:client']},
    {sourceTag: 'scope:server', onlyDependOnLibsWithTags: ['scope:shared', 'scope:server']},
    {sourceTag: 'scope:tooling', onlyDependOnLibsWithTags: ['scope:tooling']},
]

/**
 * `files` are globs relative to the project folder that lints them. `appImports` are the import
 * paths of an app this project may use anyway; Nx forbids importing apps.
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
