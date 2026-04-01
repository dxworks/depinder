import {retrieveFromNpm} from '../src/plugins/javascript'

describe('test Npm registry access', () => {
    it('access npm registry', async () => {
        const result = await retrieveFromNpm('axios')
        // console.log(result)
    }, 1000000)
})
