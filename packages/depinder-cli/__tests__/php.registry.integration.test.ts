import {PackagistRegistrar} from '../src/plugins/php'

describe('test Packagist registries access', () => {
    it('access Packagist Registry', async () => {
        const result = await new PackagistRegistrar().retrieve('laravel/laravel')
        // console.log(result)
    }, 1000000)
})
