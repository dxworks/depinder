import { inspectImports } from '../src/commands/inspect'
import { log } from '../src/utils/logging'

describe('test inspect command', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test inspect', () => {

        inspectImports(
            './demo/habitica/depinder-projects.json',
            '/Users/mario/ImportFinder/tests/extracted-imports-habitica.json', {
                results: './demo/habitica/results-habitica',
            }
        )

        log.info('Inspect command completed')
    }, 7200000)
})
