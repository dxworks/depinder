import {retrieveFormRubyGems} from '../src/plugins/ruby'

describe('test Rubygems registry access', () => {
    it('access Rubygems registry', async () => {
        const result = await retrieveFormRubyGems('rails')
        // console.log(result)
    }, 1000000)
})
