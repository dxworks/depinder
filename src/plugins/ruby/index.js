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
exports.ruby = exports.retrieveFormRubyGems = void 0;
// @ts-ignore
const gemfile = __importStar(require("@snyk/gemfile"));
const path_1 = __importDefault(require("path"));
const preload_1 = __importDefault(require("semver/preload"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const extractor = {
    files: ['Gemfile', '*.gemspec', 'Gemfile.lock'],
    createContexts: files => files.filter(it => it.endsWith('Gemfile.lock')).map(it => ({
        root: path_1.default.dirname(it),
        lockFile: path_1.default.basename(it),
    })),
};
const parser = {
    parseDependencyTree: parseLockFile,
};
function transformDeps(tree, root) {
    const result = {};
    const directDeps = new Set(Object.keys(tree.dependencies));
    Object.keys(tree.specs).forEach(specName => {
        const value = tree.specs[specName];
        const id = `${specName}@${value.version}`;
        result[id] = {
            id,
            name: specName,
            version: value.version,
            semver: preload_1.default.coerce(value.version),
            type: value.type,
            requestedBy: [],
        };
    });
    Object.keys(tree.specs).forEach(specName => {
        const value = tree.specs[specName];
        const id = `${specName}@${value.version}`;
        Object.keys(value).filter(it => !['version', 'remote', 'type'].includes(it)).forEach(spec => {
            const cachedValue = result[id];
            if (cachedValue && value[spec].version) {
                cachedValue.requestedBy = [...cachedValue.requestedBy, id];
            }
        });
    });
    // TODO: read Gemfile and add the requestedBy field for the direct dependencies
    directDeps.forEach(dep => {
        const key = Object.keys(result).find(it => it.startsWith(`${dep}@`));
        if (!key)
            return;
        const cachedValue = result[key];
        if (cachedValue) {
            cachedValue.requestedBy = [...cachedValue.requestedBy, root];
        }
    });
    return result;
}
function parseLockFile({ root, lockFile }) {
    const result = gemfile.parseSync(path_1.default.resolve(root, lockFile), true);
    return {
        name: path_1.default.basename(root),
        path: root,
        version: '',
        dependencies: transformDeps(result, `${path_1.default.basename(root)}@`),
    };
}
const registrarCache = new Map();
async function retrieveFormRubyGems(libraryName) {
    if (registrarCache.has(libraryName))
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return registrarCache.get(libraryName);
    const gemResponse = await (0, node_fetch_1.default)(`https://rubygems.org/api/v1/gems/${libraryName}.json`);
    const gemData = await gemResponse.json();
    const versionsResponse = await (0, node_fetch_1.default)(`https://rubygems.org/api/v1/versions/${libraryName}.json`);
    const versionsData = await versionsResponse.json();
    const libInfo = {
        name: gemData.name,
        versions: versionsData.map((it) => {
            return {
                version: it.number,
                timestamp: Date.parse(it.created_at),
                buildAt: Date.parse(it.built_at),
                licenses: it.licenses,
                latest: it.number == gemData.version,
                rubyVersion: it.ruby_version,
                rubygemsVersion: it.rubygems_version,
            };
        }),
        description: gemData.info,
        issuesUrl: [gemData.metadata.bug_tracker_uri],
        licenses: gemData.licenses,
        reposUrl: [gemData.metadata.source_code_uri],
        documentationUrl: gemData.metadata.documentation_uri,
        homepageUrl: gemData.homepage_uri,
        packageUrl: gemData.gem_uri,
        keywords: [],
        downloads: gemData.downloads,
    };
    registrarCache.set(libraryName, libInfo);
    return libInfo;
}
exports.retrieveFormRubyGems = retrieveFormRubyGems;
const registrar = {
    retrieve: retrieveFormRubyGems,
};
const checker = {
    githubSecurityAdvisoryEcosystem: 'RUBYGEMS',
    getPURL: (lib, ver) => `pkg:gem/${lib}@${ver}`,
};
exports.ruby = {
    name: 'ruby',
    aliases: ['gem'],
    extractor,
    parser,
    registrar,
    checker,
};
