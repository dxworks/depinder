"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMavenDependencyTree = void 0;
const utils_1 = require("../../../utils/utils");
function parseMavenDependencyTree(input) {
    const lines = input.split('\n');
    const rootLine = lines[0].split(':');
    const root = {
        name: `${rootLine[0]}:${rootLine[1]}`,
        version: rootLine[3],
        path: '',
        dependencies: {},
    };
    const stack = [];
    for (let i = 1; i < lines.length; i++) {
        // Determine the level by counting leading plus signs, each representing one level of depth.
        const level = getIndentLevel(lines[i]);
        // Remove leading special characters from the line and split into parts.
        const parts = lines[i].replaceAll('|', '').replaceAll('+-', '').replaceAll('\\-', '').trim().split(':');
        const name = `${parts[0]}:${parts[1]}`;
        const version = parts[3];
        const id = `${name}@${version}`;
        const type = parts[4]?.split(' ')[0];
        const optional = lines[i].includes('(optional)');
        const semver = (0, utils_1.getPackageSemver)(version);
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop();
        }
        root.dependencies[id] = {
            id,
            name,
            version,
            semver,
            type: optional ? undefined : type,
            requestedBy: stack.length > 0 ? [stack[stack.length - 1].id] : [`${root.name}@${root.version}`],
        };
        stack.push({ id, level });
    }
    return root;
}
exports.parseMavenDependencyTree = parseMavenDependencyTree;
function getIndentLevel(line) {
    let indentLevel = 0;
    while (line.startsWith('|  ') || line.startsWith('   ')) {
        line = line.substring(3);
        indentLevel++;
    }
    return indentLevel;
}
