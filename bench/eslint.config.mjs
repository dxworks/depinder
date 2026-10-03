import {functionSizeConfig} from '../tools/workspace-checks/function-size.eslint.mjs'

export default functionSizeConfig('bench/', ['*.ts', 'lib/**/*.ts'])
