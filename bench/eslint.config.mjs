import {functionSizeConfig} from '../tools/workspace-checks/function-size.eslint.mjs'
import {moduleBoundariesConfig} from '../tools/workspace-checks/module-boundaries.eslint.mjs'

export default [...functionSizeConfig('bench/', ['*.ts', 'lib/**/*.ts', 'test/**/*.ts']), ...moduleBoundariesConfig(['*.ts', 'lib/**/*.ts', 'test/**/*.ts'])]
