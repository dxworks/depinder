import { inspectImports } from '../src/commands/inspect'
import { log } from '../src/utils/logging'

describe('test inspect command', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('test inspect', () => {

        inspectImports(
            './results-test-meetvent/depinder-projects.json',
            './results-test-meetvent/extracted-imports-meetvent.json', {
                results: 'results-inspect-meetvent2',
            }
        )

        log.info('Inspect command completed')
    }, 7200000)
})
