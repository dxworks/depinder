import {functionSizeConfig} from './function-size.eslint.mjs'
import {moduleBoundariesConfig} from './module-boundaries.eslint.mjs'

export default [
    ...functionSizeConfig('tools/workspace-checks/', ['src/**/*.mts']),
    ...moduleBoundariesConfig(['src/**/*.mts', '__tests__/**/*.mts']),
]
