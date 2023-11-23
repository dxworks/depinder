"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllDependenciesFromComposerJson = exports.getAllDependenciesFromLock = exports.parseComposerLockFile = exports.parseComposerFile = void 0;
const fs = __importStar(require("fs"));
const php_interfaces_1 = require("../../plugins/php/php-interfaces");
function parseComposerFile(file) {
    return JSON.parse(fs.readFileSync(file).toString());
}
exports.parseComposerFile = parseComposerFile;
function parseComposerLockFile(file) {
    return JSON.parse(fs.readFileSync(file).toString());
}
exports.parseComposerLockFile = parseComposerLockFile;
async function addVersions(it) {
    const response = await (0, php_interfaces_1.getPackageDetails)(it.name);
    if (!response)
        return null;
    it.versions = response.versions;
    it.github_watchers = response.github_watchers;
    it.github_stars = response.github_starts;
    it.github_forks = response.github_forks;
    it.github_open_issues = response.github_open_issues;
    it.language = response.language;
    it.dependents = response.dependents;
    it.suggesters = response.suggesters;
    it.downloads = response.downloads;
    it.favers = response.favers;
    return it;
}
async function getAllDependenciesFromLock(deps) {
    return (await Promise.all(deps.map(it => addVersions(it)))).filter(it => it != null).map(it => it);
}
exports.getAllDependenciesFromLock = getAllDependenciesFromLock;
async function getAllDependenciesFromComposerJson(deps) {
    return (await Promise.all(deps.map(it => (0, php_interfaces_1.getPackageDetails)(it)))).filter(it => it !== null).map(it => it);
}
exports.getAllDependenciesFromComposerJson = getAllDependenciesFromComposerJson;
