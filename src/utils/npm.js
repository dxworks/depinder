"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.npm = void 0;
const child_process_1 = require("child_process");
const utils_1 = require("./utils");
exports.npm = {
    install,
    npmCommand,
};
function install(module = '', otherOptions = '', directory) {
    npmCommand(`install ${module} ${otherOptions}`, { cwd: directory, stdio: 'inherit' });
}
function npmCommand(args, options) {
    if (!options)
        return (0, child_process_1.execSync)(`${utils_1.npmExePath} ${args}`, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    else
        return (0, child_process_1.execSync)(`${utils_1.npmExePath} ${args}`, options);
}
