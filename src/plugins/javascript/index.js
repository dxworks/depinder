"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.javascript = exports.retrieveFromNpm = void 0;
const snyk_nodejs_lockfile_parser_1 = require("snyk-nodejs-lockfile-parser");
const path_1 = __importDefault(require("path"));
const semver_1 = require("semver");
const cli_common_1 = require("@dxworks/cli-common");
const npm_registry_fetch_1 = require("npm-registry-fetch");
const npm_1 = require("../../utils/npm");
const fs_1 = __importDefault(require("fs"));
const extractor = {
    files: ['package.json', 'package-lock.json', 'yarn.lock'],
    createContexts: files => {
        const lockFileContexts = files.filter(it => it.endsWith('package-lock.json') || it.endsWith('yarn.lock')).map(it => ({
            root: path_1.default.dirname(it),
            lockFile: path_1.default.basename(it),
            manifestFile: 'package.json',
        }));
        const packageJsonWithLockInParent = files.filter(it => it.endsWith('package.json'))
            .filter(packageFile => !lockFileContexts.some(it => it.root == path_1.default.dirname(packageFile)))
            .filter(packageFile => getParentLockFile(packageFile) !== null)
            .map(it => ({
            root: path_1.default.dirname(it),
            manifestFile: 'package.json',
            lockFile: getParentLockFile(it),
        }));
        const justPackageJson = files.filter(it => it.endsWith('package.json'))
            .filter(packageFile => !lockFileContexts.some(it => it.root == path_1.default.dirname(packageFile)))
            .filter(packageFile => !packageJsonWithLockInParent.some(it => it.root == path_1.default.dirname(packageFile)))
            .map(it => ({
            root: path_1.default.dirname(it),
            manifestFile: 'package.json',
        }))
            .map(context => {
            try {
                cli_common_1.log.info(`Trying to generate lock file for ${context.root}`);
                npm_1.npm.install('', '--package-lock-only', context.root);
                return {
                    ...context,
                    lockFile: path_1.default.resolve(context.root, 'package-lock.json'),
                };
            }
            catch (e) {
                cli_common_1.log.error(e);
                return null;
            }
        })
            .filter(it => it !== null)
            .map(it => it);
        return [...lockFileContexts, ...justPackageJson, ...packageJsonWithLockInParent];
    },
    filter: it => !it.includes('node_modules'),
};
function getParentLockFile(packageFile, maxDepth = 5) {
    const dir = path_1.default.dirname(packageFile);
    if (maxDepth < 0)
        return null;
    if (fs_1.default.existsSync(path_1.default.resolve(dir, 'package-lock.json')))
        return path_1.default.resolve(dir, 'package-lock.json');
    if (fs_1.default.existsSync(path_1.default.resolve(dir, 'yarn.lock')))
        return path_1.default.resolve(dir, 'yarn.lock');
    return getParentLockFile(dir, maxDepth - 1);
}
const parser = {
    parseDependencyTree: parseLockFile,
};
function recursivelyTransformDeps(tree, result) {
    const rootId = `${tree.name}@${tree.version}`;
    Object.values(tree.dependencies ?? {}).forEach(dep => {
        const id = `${dep.name}@${dep.version}`;
        const cachedVersion = result.get(id);
        if (cachedVersion) {
            cachedVersion.requestedBy = [rootId, ...cachedVersion.requestedBy];
        }
        else {
            try {
                const semver = new semver_1.SemVer(dep.version ?? '', true);
                result.set(id, {
                    id,
                    version: dep.version,
                    name: dep.name,
                    semver: semver,
                    requestedBy: [rootId],
                });
            }
            catch (e) {
                cli_common_1.log.warn(`Invalid version! ${e}`);
            }
        }
        recursivelyTransformDeps(dep, result);
    });
}
function transformDeps(tree, root) {
    cli_common_1.log.info(`Starting recursive transformation for ${root}`);
    const result = new Map();
    recursivelyTransformDeps(tree, result);
    cli_common_1.log.info(`End recursive transformation for ${root}.`);
    return result;
}
async function parseLockFile({ root, manifestFile, lockFile }) {
    // const lockFileVersion = getLockfileVersionFromFile(lockFile)
    // log.info(`parsing ${path.resolve(root, lockFile)}`)
    const result = await (0, snyk_nodejs_lockfile_parser_1.buildDepTreeFromFiles)(root, manifestFile ?? 'package.json', lockFile ?? '', true, false);
    const manifestJSON = JSON.parse(fs_1.default.readFileSync(path_1.default.resolve(root, manifestFile ?? 'package.json'), 'utf8'));
    return {
        path: path_1.default.resolve(root, manifestFile ?? 'package.json'),
        name: result.name ?? manifestJSON.name,
        version: result.version ?? manifestJSON.version,
        dependencies: Object.fromEntries(transformDeps(result, root)),
    };
}
async function retrieveFromNpm(libraryName) {
    const response = await (0, npm_registry_fetch_1.json)(libraryName);
    return {
        name: response.name,
        versions: Object.values(response.versions).map((it) => {
            return {
                version: it.version,
                timestamp: Date.parse(response.time[it.version]),
                licenses: it.license,
                latest: it.version == response['dist-tags']?.latest,
            };
        }),
        description: response.description,
        issuesUrl: [],
        licenses: [response.license],
        reposUrl: [],
        keywords: response.keywords,
    };
}
exports.retrieveFromNpm = retrieveFromNpm;
const registrar = {
    retrieve: retrieveFromNpm,
};
const checker = {
    githubSecurityAdvisoryEcosystem: 'NPM',
    getPURL: (lib, ver) => `pkg:npm/${lib.replace('@', '%40')}@${ver}`,
};
exports.javascript = {
    name: 'npm',
    aliases: ['js', 'javascript', 'node', 'nodejs', 'yarn'],
    extractor,
    parser,
    registrar,
    checker,
};
