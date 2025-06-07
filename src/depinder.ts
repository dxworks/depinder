import {Command} from 'commander'
import {_package} from './utils/utils'
import {analyseCommand} from './commands/analyse'
import {cacheCommand} from './commands/cache'
import {updateCommand} from './commands/update'
import {historyCommand} from './commands/history/history'
import { metricsCommand } from "./commands/history-metrics/metrics-command";

export const mainCommand = new Command()
    .name('depinder')
    .description(_package.description)
    .version(_package.version, '-v, -version, --version, -V')
    .addCommand(analyseCommand)
    .addCommand(updateCommand)
    .addCommand(cacheCommand)
    .addCommand(historyCommand)
    .addCommand(metricsCommand)

