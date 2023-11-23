"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dotnet = exports.registrar = exports.NugetRegistrar = exports.runNugetInspector = void 0;
const axios_1 = __importDefault(require("axios"));
const registrar_1 = require("../../extension-points/registrar");
const moment_1 = __importDefault(require("moment"));
const nuget_inspector_1 = require("@dxworks/nuget-inspector");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const utils_1 = require("../../utils/utils");
const cli_common_1 = require("@dxworks/cli-common");
const extractor = {
    files: ['*.csproj', '*.fsproj', '*.vbproj'],
    createContexts: (files) => files.map(it => ({
        root: path_1.default.dirname(it),
        manifestFile: it,
    })),
};
function transformNugetInspectorResult(result) {
    const project = result.Containers[0];
    const projectId = `${project.Name}@${project.Version}`;
    if (!project) {
        throw new Error('Parsing NuGet Inspector result failed.');
    }
    const depMap = new Map();
    project.Packages.forEach((pack) => {
        const packageId = `${pack.PackageId.Name}@${pack.PackageId.Version}`;
        if (!depMap.has(packageId)) {
            depMap.set(packageId, {
                name: pack.PackageId.Name,
                version: pack.PackageId.Version,
                id: packageId,
                semver: (0, utils_1.getPackageSemver)(pack.PackageId.Version),
                requestedBy: [],
                type: 'library',
            });
        }
        pack.Dependencies.forEach((dep) => {
            const depId = `${dep.Name}@${dep.Version}`;
            if (!depMap.has(depId)) {
                depMap.set(depId, {
                    name: dep.Name,
                    version: dep.Version,
                    id: depId,
                    semver: (0, utils_1.getPackageSemver)(dep.Version),
                    requestedBy: [packageId],
                    type: 'library',
                });
            }
            else {
                const cachedDep = depMap.get(depId);
                if (cachedDep) {
                    cachedDep.requestedBy.push(packageId);
                }
            }
        });
    });
    project.Dependencies.forEach((dep) => {
        const depId = `${dep.Name}@${dep.Version}`;
        if (depMap.has(depId)) {
            const cachedDep = depMap.get(depId);
            if (cachedDep) {
                cachedDep.requestedBy.push(projectId);
            }
        }
    });
    return {
        name: project.Name,
        version: project.Version,
        path: project.SourcePath,
        dependencies: Object.fromEntries(depMap),
    };
}
async function runNugetInspector(context) {
    const tempFile = path_1.default.resolve(`${context.manifestFile}.json`);
    if (!fs_1.default.existsSync(tempFile)) {
        try {
            await (0, nuget_inspector_1.runNuGetInspectorProgrammatically)(context.root, tempFile, process.cwd());
        }
        catch (e) {
            cli_common_1.log.error(e);
            throw new Error(`NuGet Inspector failed for project ${context.root}`);
        }
    }
    const result = JSON.parse(fs_1.default.readFileSync(tempFile).toString());
    return transformNugetInspectorResult(result);
}
exports.runNugetInspector = runNugetInspector;
const parser = {
    parseDependencyTree: runNugetInspector,
};
const checker = {
    githubSecurityAdvisoryEcosystem: 'NUGET',
    getPURL: (lib, ver) => `pkg:nuget/${lib.replace('@', '%40')}@${ver}`,
};
class NugetRegistrar extends registrar_1.AbstractRegistrar {
    constructor() {
        super(...arguments);
        this.baseURL = 'https://api.nuget.org/v3/registration5-gz-semver1';
    }
    async retrieveFromRegistry(libraryName) {
        const response = await axios_1.default.get(`${this.baseURL}/${libraryName.toLowerCase()}/index.json`);
        return this.parseData(response.data);
    }
    parseData(responseData) {
        const versions = responseData?.items?.flatMap((it) => it.items) || [];
        versions.sort((a, b) => (0, moment_1.default)(b.catalogEntry.published).valueOf() - (0, moment_1.default)(a.catalogEntry.published).valueOf());
        const latestVersion = versions[0].catalogEntry.version;
        // if(versions) {
        return {
            name: versions[0].catalogEntry.id,
            versions: versions?.map(it => {
                return {
                    version: it.catalogEntry.version,
                    licenses: `${it.catalogEntry?.licenseExpression || ''} ${it.catalogEntry?.licenseUrl}`.trim(),
                    timestamp: (0, moment_1.default)(it.catalogEntry.published).valueOf(),
                    latest: it.catalogEntry.version === latestVersion,
                };
            }),
            licenses: [...new Set(versions.map(it => `${it.catalogEntry?.licenseExpression || ''} ${it.catalogEntry?.licenseUrl}`.trim()))],
            requiresLicenseAcceptance: versions.some(it => it.catalogEntry.requireLicenseAcceptance),
        };
    }
}
exports.NugetRegistrar = NugetRegistrar;
class NugetRegistrarSemver2 extends NugetRegistrar {
    constructor() {
        super(...arguments);
        this.baseURL = 'https://api.nuget.org/v3/registration5-gz-semver2';
    }
}
exports.registrar = new NugetRegistrar(new NugetRegistrarSemver2(new registrar_1.LibrariesIORegistrar('nuget')));
exports.dotnet = {
    name: 'dotnet',
    aliases: ['.net', 'c#', 'csharp', 'nuget'],
    extractor,
    parser,
    registrar: exports.registrar,
    checker,
};
