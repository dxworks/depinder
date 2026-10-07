import {functionSizeConfig} from '../../tools/workspace-checks/function-size.eslint.mjs'
import {moduleBoundariesConfig} from '../../tools/workspace-checks/module-boundaries.eslint.mjs'

export default [
    ...functionSizeConfig('packages/parity/', ['test/**/*.ts']),
    // Only the two apps' in-process entry points get through; every other import follows the tags.
    ...moduleBoundariesConfig(['test/**/*.ts'], ['@dxworks/depinder/fallback', 'depinder-server/in-process']),
]
