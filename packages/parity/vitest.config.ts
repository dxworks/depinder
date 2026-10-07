import {defineConfig} from 'vitest/config'

export default defineConfig({
    // The three projects from their TypeScript sources (node tests resolve as SSR)
    ssr: {resolve: {conditions: ['depinder-source']}},
    test: {
        include: ['test/**/*.test.ts'],
        environment: 'node',
        // One database, one stubbed global fetch: the cases run one after another
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 30_000,
    },
})
