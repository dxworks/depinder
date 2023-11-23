"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.php = exports.PackagistRegistrar = exports.parseComposerLockFile = exports.parseComposerFile = void 0;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const registrar_1 = require("../../extension-points/registrar");
const php_interfaces_1 = require("./php-interfaces");
const utils_1 = require("../../utils/utils");
const extractor = {
    files: ['composer.json', 'composer.lock'],
    createContexts: files => {
        return files.filter(it => it.endsWith('composer.lock')).map(it => ({
            root: path_1.default.dirname(it),
            lockFile: path_1.default.basename(it),
            manifestFile: 'composer.json',
        }));
    },
    filter: it => !it.includes('/vendor'),
};
function parseComposerFile(file) {
    return JSON.parse(fs_1.default.readFileSync(file).toString());
}
exports.parseComposerFile = parseComposerFile;
function parseComposerLockFile(file) {
    return JSON.parse(fs_1.default.readFileSync(file).toString());
}
exports.parseComposerLockFile = parseComposerLockFile;
const parser = {
    parseDependencyTree: parseLockFile,
};
async function parseLockFile({ root, manifestFile, lockFile }) {
    if (!manifestFile) {
        throw new Error('No manifest file found!');
    }
    const composer = parseComposerFile(path_1.default.join(root, manifestFile));
    let dependencies;
    if (lockFile) {
        const composerLock = parseComposerLockFile(path_1.default.join(root, lockFile));
        dependencies = composerLock.packages.map(it => {
            const name = it.name;
            const version = it.version;
            const id = `${name}@${version}`;
            const semver = (0, utils_1.getPackageSemver)(version ?? '');
            const type = 'prod';
            const requestedBy = [];
            return {
                id,
                name,
                version,
                semver,
                type,
                requestedBy,
            };
        }).reduce((acc, it) => {
            acc[it.id] = it;
            return acc;
        }, {});
        const allLibs = Object.values(dependencies);
        composerLock.packages.forEach(it => {
            Object.keys(it.require ?? {}).forEach(name => {
                const dep = allLibs.find(lib => lib.name === name);
                if (dep) {
                    dep.requestedBy.push(it.name);
                }
            });
        });
        Object.keys(composer.require ?? {}).forEach(name => {
            const dep = allLibs.find(lib => lib.name === name);
            if (dep) {
                dep.requestedBy.push(`${composer.name}@${composer.version}`);
            }
        });
    }
    if (dependencies == null) {
        // get dependencies from composer.json
        dependencies = {};
    }
    return {
        name: composer.name,
        version: composer.version || '',
        path: root,
        dependencies,
    };
}
class PackagistRegistrar extends registrar_1.AbstractRegistrar {
    async retrieveFromRegistry(libraryName) {
        const response = await (0, php_interfaces_1.getPackageDetails)(libraryName);
        const latestVersion = Object.values(response.versions)
            .filter((it) => !it.version.includes('dev'))
            .sort((a, b) => {
            return Date.parse(b.time) - Date.parse(a.time);
        })[0]?.version;
        return {
            name: response.name,
            versions: Object.values(response.versions).map((it) => {
                return {
                    version: it.version,
                    timestamp: Date.parse(it.time),
                    licenses: it.license,
                    latest: it.version === latestVersion,
                };
            }),
            description: response.description,
            issuesUrl: [],
            licenses: [...new Set(Object.values(response.versions).flatMap((it) => it.license).filter((it) => it != null))],
            reposUrl: [],
            keywords: [],
        };
    }
}
exports.PackagistRegistrar = PackagistRegistrar;
const phpRegistrar = new PackagistRegistrar(new registrar_1.LibrariesIORegistrar('packagist'));
const checker = {
    githubSecurityAdvisoryEcosystem: 'COMPOSER',
    getPURL: (lib, ver) => `pkg:composer/${lib.replace('@', '%40')}@${ver}`,
};
exports.php = {
    name: 'php',
    aliases: ['composer'],
    extractor,
    parser,
    registrar: phpRegistrar,
    checker,
};
