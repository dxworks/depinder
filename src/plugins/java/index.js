"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.java = exports.MavenCentralRegistrar = void 0;
// @ts-ignore
const path_1 = __importDefault(require("path"));
const registrar_1 = require("../../extension-points/registrar");
const node_fetch_1 = __importDefault(require("node-fetch"));
const fs_1 = __importDefault(require("fs"));
const utils_1 = require("../../utils/utils");
const cli_common_1 = require("@dxworks/cli-common");
const maven_1 = require("./parsers/maven");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pomParser = require('pom-parser');
const extractor = {
    files: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    createContexts: files => {
        const pomContexts = files.filter(it => it.endsWith('pom.xml')).map(it => ({
            root: path_1.default.dirname(it),
            lockFile: 'deptree.txt',
            type: 'maven',
        }));
        const gradleContexts = files.filter(it => it.endsWith('build.gradle') || it.endsWith('build.gradle.kts')).map(it => ({
            root: path_1.default.dirname(it),
            manifestFile: path_1.default.basename(it),
            lockFile: 'gradle.json',
            type: 'gradle',
        }));
        return [...pomContexts, ...gradleContexts];
    },
};
const parser = {
    parseDependencyTree: parseLockFile,
};
function parseLockFile(context) {
    if (context.type === 'maven') {
        if (!fs_1.default.existsSync(path_1.default.resolve(context.root, context.lockFile))) {
            throw new Error(`Dependency tree file not found: ${path_1.default.resolve(context.root, context.lockFile)}`);
        }
        const depTreeContent = fs_1.default.readFileSync(path_1.default.resolve(context.root, context.lockFile)).toString();
        const depinderProject = (0, maven_1.parseMavenDependencyTree)(depTreeContent);
        depinderProject.path = path_1.default.resolve(context.root, context.manifestFile ?? 'pom.xml');
        return depinderProject;
    }
    else if (context.type === 'gradle') {
        throw new Error(`Unsupported context type: ${context.type}. Gradle is not supported yet!`);
    }
    // if (context.type === 'maven-with-dep-tree') {
    //     return JSON.parse(fs.readFileSync(path.resolve(context.root, context.lockFile)).toString()) as DepinderProject
    // }
    //
    // if (context.type === 'gradle') {
    //     if (fs.existsSync(path.resolve(context.root, context.lockFile))) {
    //         const proj = JSON.parse(fs.readFileSync(path.resolve(context.root, context.lockFile)).toString()) as DepinderProject
    //         return {
    //             ...proj,
    //             dependencies: Object.entries(proj.dependencies).filter(([, value]) =>
    //                 value.requestedBy.includes(`${proj.name}@${proj.version}`)
    //             ).reduce((acc, [key, value]) => ({...acc, [key]: value}), {}),
    //         }
    //     }
    // }
    throw new Error(`Unsupported context type: ${context.type}`);
}
async function parsePomFile(pomFile) {
    return new Promise((resolve, reject) => {
        pomParser.parse({ filePath: pomFile }, (err, pom) => {
            if (err) {
                reject(err);
            }
            resolve(pom);
        });
    });
}
async function getLatestAvailablePom(groupId, artifactId, docs) {
    for (let i = 0; i < docs.length; i++) {
        const pomUrl = `https://search.maven.org/remotecontent?filepath=${groupId.replace(/\./g, '/')}/${artifactId}/${docs[i].v}/${artifactId}-${docs[i].v}.pom`;
        const pomResponse = await (0, node_fetch_1.default)(pomUrl);
        if (pomResponse.status === 200)
            return pomResponse;
    }
}
const checker = {
    githubSecurityAdvisoryEcosystem: 'MAVEN',
    getPURL: (lib, ver) => `pkg:maven/${lib.replace(':', '/')}@${ver}`,
};
class MavenCentralRegistrar extends registrar_1.AbstractRegistrar {
    async retrieveFromRegistry(libraryName) {
        const [groupId, artifactId] = libraryName.split(':');
        const abortController = new AbortController();
        setTimeout(() => abortController.abort(), 10000);
        const rows = 200;
        let start = 0;
        const mavenSearchURL = `https://search.maven.org/solrsearch/select?q=g:"${groupId}" AND a:"${artifactId}"&core=gav&wt=json&rows=${rows}&start=${start}`;
        const mavenResponse = await (0, node_fetch_1.default)(mavenSearchURL, { signal: abortController.signal });
        const mavenData = await mavenResponse.json();
        let docs = mavenData.response.docs;
        while (docs.length < mavenData.response.numFound) {
            start += rows;
            const mavenResponse = await (0, node_fetch_1.default)(mavenSearchURL, { signal: abortController.signal });
            const mavenData = await mavenResponse.json();
            docs = [...docs, ...mavenData.response.docs];
        }
        let pom;
        try {
            pom = (await this.getPom(groupId, artifactId, docs, libraryName)).pomObject;
        }
        catch (e) {
            cli_common_1.log.warn(`Failed to get pom for ${libraryName}`);
            throw e;
        }
        return {
            name: libraryName,
            versions: docs.map((it) => {
                return {
                    version: it.v,
                    timestamp: it.timestamp,
                    latest: it.v === docs[0].v,
                    licenses: [],
                };
            }),
            description: pom?.project?.description ?? '',
            licenses: pom?.project?.licenses?.license ? [pom?.project.licenses.license.name] : [],
            reposUrl: pom?.project?.scm ? [pom?.project.scm.connection] : [],
            issuesUrl: pom?.project?.issueManagement?.url ? [pom?.project.issueManagement.url] : [],
        };
    }
    async getPom(groupId, artifactId, docs, libraryName) {
        const pomResponse = await getLatestAvailablePom(groupId, artifactId, docs);
        const pomData = await pomResponse.text();
        const pomFile = path_1.default.resolve(utils_1.depinderTempFolder, `${libraryName}.pom`);
        fs_1.default.writeFileSync(pomFile, pomData);
        const pom = await parsePomFile(pomFile);
        fs_1.default.rmSync(pomFile);
        return pom;
    }
}
exports.MavenCentralRegistrar = MavenCentralRegistrar;
const javaRegistrar = new MavenCentralRegistrar(new registrar_1.LibrariesIORegistrar('maven'));
exports.java = {
    name: 'java',
    aliases: ['maven', 'gradle'],
    extractor,
    parser,
    registrar: javaRegistrar,
    checker,
};
