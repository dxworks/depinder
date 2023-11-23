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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.python = exports.pythonRegistrar = void 0;
// @ts-ignore
const path_1 = __importDefault(require("path"));
const registrar_1 = require("../../extension-points/registrar");
const node_fetch_1 = __importDefault(require("node-fetch"));
const fs_1 = __importDefault(require("fs"));
const moment_1 = __importDefault(require("moment"));
const cli_common_1 = require("@dxworks/cli-common");
const child_process_1 = require("child_process");
const toml = __importStar(require("toml"));
const utils_1 = require("../../utils/utils");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const extractor = {
    files: ['requirements.txt', 'setup.py', 'Pipfile', 'Pipfile.lock', 'pyproject.toml', 'poetry.lock'],
    createContexts: files => {
        const pipEnvContexts = files.filter(it => it.endsWith('Pipfile.lock')).map(it => ({
            root: path_1.default.dirname(it),
            lockFile: path_1.default.basename(it),
            manifestFile: 'Pipfile',
        }));
        const justPipFiles = files.filter(it => it.endsWith('Pipfile'))
            .filter(packageFile => !pipEnvContexts.some(it => it.root == path_1.default.dirname(packageFile)))
            .map(it => ({
            root: path_1.default.dirname(it),
            manifestFile: 'Pipfile',
        }))
            .map(context => {
            try {
                cli_common_1.log.info(`Trying to generate lock file for ${context.root}`);
                (0, child_process_1.execSync)('pipenv lock', { cwd: context.root });
                return {
                    ...context,
                    lockFile: path_1.default.resolve(context.root, 'Pipfile.lock'),
                };
            }
            catch (e) {
                cli_common_1.log.error(e);
                return null;
            }
        })
            .filter(it => it !== null)
            .map(it => it);
        return [...pipEnvContexts, ...justPipFiles].map(context => {
            try {
                if (!fs_1.default.existsSync(path_1.default.resolve(context.root, 'PipTree.json'))) {
                    (0, child_process_1.execSync)('pipenv install', { cwd: context.root });
                    const tree = (0, child_process_1.execSync)('pipenv graph --json', { cwd: context.root }).toString();
                    fs_1.default.writeFileSync(path_1.default.resolve(context.root, 'PipTree.json'), tree);
                }
                return {
                    ...context,
                    tree: path_1.default.resolve(context.root, 'PipTree.json'),
                };
            }
            catch (e) {
                cli_common_1.log.error(`Could not generate pipenv tree for project ${context.root}`, e);
                return context;
            }
        });
    },
};
const parser = {
    parseDependencyTree: parseLockFile,
};
function transformDeps(tree) {
    const cache = new Map();
    function handleNode(node) {
        const id = `${node.package_name}@${node.installed_version}`;
        if (!cache.has(id)) {
            const newNode = {
                id,
                version: node.installed_version,
                name: node.package_name,
                requestedBy: [],
                semver: (0, utils_1.getPackageSemver)(node.installed_version),
            };
            cache.set(id, newNode);
            return newNode;
        }
        else {
            return cache.get(id);
        }
    }
    tree.forEach(entry => {
        const node = handleNode(entry.package);
        entry.dependencies.forEach(dep => {
            const depNode = handleNode(dep);
            depNode.requestedBy.push(node.id);
        });
    });
    return Object.fromEntries(cache);
}
function parseLockFile(context) {
    const projName = path_1.default.basename(context.root);
    let directDeps = [];
    if (context.manifestFile === 'Pipfile') {
        try {
            const pipfile = toml.parse(fs_1.default.readFileSync(path_1.default.resolve(context.root, context.manifestFile)).toString());
            directDeps = Object.keys(pipfile.packages);
        }
        catch (e) {
            cli_common_1.log.error(e);
        }
        let dependencies = {};
        // @ts-ignore
        const treePath = context.tree;
        if (treePath) {
            const tree = JSON.parse(fs_1.default.readFileSync(treePath).toString());
            dependencies = transformDeps(tree);
        }
        else {
            const lockFile = JSON.parse(fs_1.default.readFileSync(path_1.default.resolve(context.root, context.lockFile)).toString());
            dependencies = Object.entries(lockFile.default).map(([name, obj]) => {
                const version = obj.version?.replace('==', '') ?? '';
                return {
                    name,
                    id: `${name}@${version}`,
                    version: version,
                    path: context.root,
                    dependencies: {},
                    type: 'production',
                    requestedBy: [],
                    semver: (0, utils_1.getPackageSemver)(version),
                };
            }).reduce((acc, it) => {
                acc[it.id] = it;
                return acc;
            }, {});
        }
        const allDeps = Object.keys(dependencies);
        directDeps.forEach(dep => {
            const directDep = allDeps.find(it => it.startsWith(`${dep}@`));
            if (directDep) {
                if (dependencies[directDep]) {
                    dependencies[directDep].requestedBy.push(`${projName}@`);
                }
            }
        });
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies,
        };
    }
    else if (context.manifestFile === 'pyproject.toml') {
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies: {},
        };
    }
    else if (context.manifestFile === 'setup.py') {
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies: {},
        };
    }
    else if (context.manifestFile === 'requirements.txt') {
        return {
            name: projName,
            version: '',
            path: context.root,
            dependencies: {},
        };
    }
    throw new Error(`Unsupported manifest file ${JSON.stringify(context)}`);
}
const checker = {
    githubSecurityAdvisoryEcosystem: 'PIP',
    getPURL: (lib, ver) => `pkg:pypi/${lib.replace('@', '%40')}@${ver}`,
};
class PyPiRegistrar extends registrar_1.AbstractRegistrar {
    async retrieveFromRegistry(libraryName) {
        const pypiURL = `https://pypi.org/pypi/${libraryName}/json`;
        const pypiResponse = await (0, node_fetch_1.default)(pypiURL);
        const pypiData = await pypiResponse.json();
        return {
            name: libraryName,
            versions: Object.entries(pypiData.releases).map(([ver, it]) => {
                return {
                    version: ver,
                    timestamp: it.length > 0 ? (0, moment_1.default)(it[0].upload_time).valueOf() : 0,
                    latest: ver === pypiData.info.version,
                    licenses: [],
                };
            }),
            description: pypiData.info.description ?? pypiData.info.summary ?? '',
            licenses: pypiData.info.license ? [pypiData.info.license] : [],
            homepageUrl: pypiData.info.home_page ?? '',
            keywords: pypiData.info.keywords ?? [],
            authors: pypiData.info.author ? [pypiData.info.author] : [],
            issuesUrl: pypiData.info.bugtrack_url ?? '',
            downloads: pypiData.info.downloads?.last_month ?? 0,
            packageUrl: pypiData.info.package_url ?? '',
        };
    }
}
exports.pythonRegistrar = new PyPiRegistrar(new registrar_1.LibrariesIORegistrar('pypi'));
exports.python = {
    name: 'python',
    aliases: ['pip', 'pipenv', 'poetry'],
    extractor,
    parser,
    registrar: exports.pythonRegistrar,
    checker,
};
