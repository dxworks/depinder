"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheCommand = exports.cacheInitCommand = exports.cacheInfoCommand = exports.cacheDownCommand = exports.cacheUpCommand = exports.cacheInitAction = exports.cacheInfoAction = exports.getMongoDockerContainerStatus = exports.cacheDownAction = exports.cacheUpAction = void 0;
const commander_1 = require("commander");
const child_process_1 = require("child_process");
const cli_common_1 = require("@dxworks/cli-common");
const chalk_1 = __importDefault(require("chalk"));
const fs_1 = __importDefault(require("fs"));
const utils_1 = require("../utils/utils");
const path_1 = __importDefault(require("path"));
async function cacheUpAction() {
    (0, child_process_1.execSync)('docker-compose up -d', { cwd: path_1.default.resolve((0, utils_1.getHomeDir)(), 'cache'), stdio: 'inherit' });
}
exports.cacheUpAction = cacheUpAction;
async function cacheDownAction() {
    (0, child_process_1.execSync)('docker-compose down', { cwd: path_1.default.resolve((0, utils_1.getHomeDir)(), 'cache'), stdio: 'inherit' });
}
exports.cacheDownAction = cacheDownAction;
function getMongoDockerContainerStatus() {
    try {
        const output = (0, child_process_1.execSync)('docker inspect depinder-mongo').toString();
        const result = JSON.parse(output);
        if (result.length == 0) {
            cli_common_1.log.error('Mongo is not running');
            return null;
        }
        return result[0].State.Status;
    }
    catch (e) {
        return null;
    }
}
exports.getMongoDockerContainerStatus = getMongoDockerContainerStatus;
function cacheInfoAction() {
    const status = getMongoDockerContainerStatus();
    if (status == null) {
        cli_common_1.log.error('Mongo is not running');
        cli_common_1.log.info(`To start Mongo cache run: ${chalk_1.default.yellow('depinder cache up')}`);
        return;
    }
    if (status == 'running') {
        cli_common_1.log.info(chalk_1.default.green('Mongo cache is up and running'));
    }
    else {
        cli_common_1.log.info(`Mongo is ${status}`);
        cli_common_1.log.info(`To start Mongo cache run: ${chalk_1.default.yellow('depinder cache up')}`);
    }
}
exports.cacheInfoAction = cacheInfoAction;
function cacheInitAction() {
    if (!fs_1.default.existsSync(path_1.default.join((0, utils_1.getHomeDir)(), 'cache', 'docker-compose.yml'))) {
        fs_1.default.mkdirSync(path_1.default.join((0, utils_1.getHomeDir)(), 'cache'), { recursive: true });
        fs_1.default.copyFileSync((0, utils_1.getAssetFile)('depinder.docker-compose.yml'), path_1.default.join((0, utils_1.getHomeDir)(), 'cache', 'docker-compose.yml'));
        fs_1.default.copyFileSync((0, utils_1.getAssetFile)('init-mongo.js'), path_1.default.join((0, utils_1.getHomeDir)(), 'cache', 'init-mongo.js'));
    }
}
exports.cacheInitAction = cacheInitAction;
exports.cacheUpCommand = new commander_1.Command()
    .name('up')
    .alias('start')
    .action(cacheUpAction);
exports.cacheDownCommand = new commander_1.Command()
    .name('down')
    .alias('stop')
    .action(cacheDownAction);
exports.cacheInfoCommand = new commander_1.Command()
    .name('info')
    .alias('i')
    .action(cacheInfoAction);
exports.cacheInitCommand = new commander_1.Command()
    .name('init')
    .action(cacheInitAction);
exports.cacheCommand = new commander_1.Command()
    .name('cache')
    .action(cacheInfoAction)
    .addCommand(exports.cacheUpCommand)
    .addCommand(exports.cacheDownCommand)
    .addCommand(exports.cacheInfoCommand)
    .addCommand(exports.cacheInitCommand);
