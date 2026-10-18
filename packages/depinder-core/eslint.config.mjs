import {functionSizeConfig} from '../../tools/workspace-checks/function-size.eslint.mjs'
import {moduleBoundariesConfig} from '../../tools/workspace-checks/module-boundaries.eslint.mjs'

export default [
    ...functionSizeConfig('packages/depinder-core/', ['src/**/*.ts', 'scripts/**/*.ts']),
    ...moduleBoundariesConfig(['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts']),
]
