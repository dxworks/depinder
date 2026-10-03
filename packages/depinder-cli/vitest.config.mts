import {defineConfig} from 'vitest/config'

export default defineConfig({
    // @depinder/core from its TypeScript sources, as in tsconfig.json (node tests resolve as SSR)
    ssr: {resolve: {conditions: ['depinder-source']}},
    test: {
        include: ['__tests__/**/*.test.ts'],
        environment: 'node',
        globals: true,
    },
})
