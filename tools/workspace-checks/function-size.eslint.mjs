// The function-size rule (~100 lines, NX_MIGRATION.md D10) as a flat config, for projects whose
// lint is only this rule. Files listed in size-baseline.json under longFunctions only warn.
import tseslint from 'typescript-eslint'
import {readFileSync} from 'node:fs'

const sizeBaseline = JSON.parse(readFileSync(new URL('./size-baseline.json', import.meta.url), 'utf8'))
export const FUNCTION_LENGTH = {max: 100, skipBlankLines: true, skipComments: true}

/** `projectPrefix` is the project's repo-relative folder with a trailing slash; `files` are globs in it. */
export function functionSizeConfig(projectPrefix, files) {
    const baselined = sizeBaseline.longFunctions
        .filter(file => file.startsWith(projectPrefix))
        .map(file => file.slice(projectPrefix.length))
    return [
        {
            files,
            languageOptions: {parser: tseslint.parser},
            linterOptions: {reportUnusedDisableDirectives: 'off'},
            rules: {'max-lines-per-function': ['error', FUNCTION_LENGTH]},
        },
        ...(baselined.length > 0 ? [{files: baselined, rules: {'max-lines-per-function': ['warn', FUNCTION_LENGTH]}}] : []),
        {ignores: ['dist/**', 'node_modules/**', 'runs/**']},
    ]
}
