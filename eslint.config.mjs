import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        rules: {
            // Original rules (relaxed)
            'comma-dangle': 'off',
            'quotes': 'off',
            'semi': 'off',

            // TypeScript rules - all off for now
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/ban-ts-comment': 'off',
            '@typescript-eslint/no-empty-function': 'off',
            '@typescript-eslint/no-unused-vars': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/no-empty-object-type': 'off',
            '@typescript-eslint/no-unsafe-function-type': 'off',

            // ESLint core rules - all off for now
            'no-unused-vars': 'off',
            'no-empty': 'off',
            'no-constant-condition': 'off',
            'no-prototype-builtins': 'off',
            'no-useless-escape': 'off',
            'no-case-declarations': 'off',
            'no-async-promise-executor': 'off',
            'prefer-const': 'off',
        },
    },
    {
        ignores: ['dist/**', 'node_modules/**', '**/*.js'],
    }
)