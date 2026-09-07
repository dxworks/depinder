import {pythonRegistrar} from '../src/plugins/python'

describe('test PyPi registry access', () => {
    it('access PyPi registry', async () => {
        const result = await pythonRegistrar.retrieve('requests')
        // console.log(result)
    }, 1000000)
})
