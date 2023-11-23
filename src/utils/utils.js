"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPackageSemver = exports.delay = exports.walkDir = exports.getHomeDir = exports.depinderTempFolder = exports.depinderFolder = exports.npmExePath = exports.getAssetFile = exports._package = void 0;
const path_1 = __importDefault(require("path"));
const os_1 = require("os");
const fs_1 = __importDefault(require("fs"));
const semver_1 = require("semver");
const preload_1 = __importDefault(require("semver/preload"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
exports._package = require('../../package.json');
function getAssetFile(assetName) {
    return path_1.default.join(__dirname, '..', 'assets', assetName);
}
exports.getAssetFile = getAssetFile;
exports.npmExePath = getBin('npm');
function getBin(exe) {
    return path_1.default.resolve(__dirname, '..', '..', 'node_modules', '.bin', exe);
}
exports.depinderFolder = path_1.default.join((0, os_1.homedir)(), '.dxw', 'depinder');
exports.depinderTempFolder = path_1.default.join(exports.depinderFolder, 'temp');
function getHomeDir() {
    if (!fs_1.default.existsSync(exports.depinderFolder)) {
        fs_1.default.mkdirSync(exports.depinderFolder);
    }
    if (!fs_1.default.existsSync(exports.depinderTempFolder)) {
        fs_1.default.mkdirSync(exports.depinderTempFolder);
    }
    return exports.depinderFolder;
}
exports.getHomeDir = getHomeDir;
function walkDir(dir) {
    const allChildren = fs_1.default.readdirSync(dir);
    const files = allChildren.map(it => path_1.default.resolve(dir, it)).filter(it => fs_1.default.lstatSync(it).isFile());
    return [...files, ...allChildren.map(it => path_1.default.resolve(dir, it)).filter(it => fs_1.default.lstatSync(it).isDirectory()).flatMap(it => walkDir(path_1.default.resolve(dir, it)))];
}
exports.walkDir = walkDir;
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
exports.delay = delay;
function getPackageSemver(version) {
    try {
        return new semver_1.SemVer(version);
    }
    catch (e) {
        try {
            return new semver_1.SemVer(version, { loose: true });
        }
        catch (e) {
            return preload_1.default.coerce(version);
        }
    }
}
exports.getPackageSemver = getPackageSemver;
