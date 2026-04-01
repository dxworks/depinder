import {MavenCentralRegistrar} from '../src/plugins/java'

describe('test all Maven registries access', () => {
    const runOnlyLocally = process.env.CI ? test.skip : test

    runOnlyLocally('access Maven Central Registry', async () => {
        const result = await new MavenCentralRegistrar().retrieve('com.fasterxml.jackson.core:jackson-databind')
        // console.log(result)
    }, 1000000)
})
