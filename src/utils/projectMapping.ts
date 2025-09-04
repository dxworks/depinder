/**
 * Project mapping utilities for extracting project information from dependency paths
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Interface for path mapping configuration
 */
export interface PathMapping {
    extractedPath: string;
    actualPath: string;
}

/**
 * Map of extracted paths to actual paths
 */
export type PathMappings = Map<string, string>;

const END_DELIMITERS = [
    '-yarn',
    '-npm',
    'node_modules',
    '-pip',
    '-maven',
    '-gradle',
    '-nuget',
    '-sbt',
    '-cargo',
    '-packagist'
];

// Special case pattern for monorepo
const MONOREPO_PATTERN = /packages[\\/]([^\\/]+)[\\/]local[\\/]([^\\/]+)[\\/]-yarn/;

/**
 * Interface representing a parsed project path
 */
export interface ProjectPathInfo {
    projectPath: string;
    verifiedPath: string;
    projectPathExists?: boolean;
}

/**
 * Check if a segment contains a version-like pattern
 * @param segment Path segment to check
 * @returns True if the segment looks like a version
 */
function isVersionSegment(segment: string): boolean {
    return /^\d+\.\d+\.\d+(-.*)?$/i.test(segment) ||
        /^REPLACE_BY_CI$/i.test(segment) ||
        /^[\d\.]+(-SNAPSHOT|-placeholder)?$/i.test(segment) ||
        segment.toLowerCase() === 'unspecified';
}

/**
 * Check if a segment contains a file that should be excluded
 * @param segment Path segment to check
 * @returns True if the segment contains a file to exclude
 */
function isFileSegment(segment: string): boolean {
    return segment.toLowerCase().endsWith('.csproj') ||
        segment.toLowerCase().endsWith('.props') ||
        segment.toLowerCase() === 'pom.xml';
}

/**
 * Check if a segment is an organization/company prefix that should be skipped
 * @param segment Path segment to check
 * @returns True if the segment looks like an organization prefix
 */
function isOrganizationPrefix(segment: string): boolean {
    // Common organization prefixes like com.company, org.apache, etc.
    return /^(com|org|net|edu|gov)\.[a-zA-Z0-9.-]+$/.test(segment);
}

/**
 * Resolves a path with relative segments (.., .)
 * @param pathSegments Array of path segments to resolve
 * @returns Array of resolved path segments
 */
function resolveRelativePath(pathSegments: string[]): string[] {
    const result: string[] = [];
    let skipCount = 0;

    for (const segment of pathSegments) {
        if (segment === '..') {
            skipCount++;
        } else if (segment !== '.' && segment !== '') {
            if (skipCount > 0) {
                // This segment is skipped because of a '..'
                skipCount--;
            } else {
                result.push(segment);
            }
        }
    }
    return result;
}

/**
 * Standardizes a path by normalizing slashes, colons, and removing leading/trailing slashes
 * @param inputPath Path to standardize
 * @returns Standardized path
 */
function standardizePath(inputPath: string): string {
    if (!inputPath) {
        return '';
    }

    let normalizedPath = inputPath.replace(/\\/g, '/');

    normalizedPath = normalizedPath.replace(/:/g, '/');

    if (normalizedPath.startsWith('/')) {
        normalizedPath = normalizedPath.substring(1);
    }

    if (normalizedPath.endsWith('/')) {
        normalizedPath = normalizedPath.substring(0, normalizedPath.length - 1);
    }

    return normalizedPath;
}

/**
 * Check if a path matches the monorepo pattern and extract the project path
 * @param path Normalized path to check
 * @returns Project path if monorepo pattern matches, null otherwise
 */
function handleMonorepoPattern(path: string): string | null {
    const matches = path.match(MONOREPO_PATTERN);
    if (matches) {
        return `${matches[2]}/packages/${matches[1]}`;
    }
    return null;
}

/**
 * Parse project path from dependency path
 * @param dependencyPath The path from the Black Duck report
 * @returns Extracted project path
 */
function parseProjectPath(dependencyPath: string): string {
    if (!dependencyPath) {
        return '';
    }

    try {
        const normalizedPath = standardizePath(dependencyPath);

        const monorepoPath = handleMonorepoPattern(normalizedPath);
        if (monorepoPath) {
            return monorepoPath;
        }

        const segments = normalizedPath.split('/');

        let endDelimiterIndex = getEndDelimiterIndex(segments);

        if (endDelimiterIndex === -1) {
            throw new Error(`No end delimiter found in path: ${normalizedPath}`);
        }

        let projectSegments = segments.slice(0, endDelimiterIndex);

        if (projectSegments.length > 0 && isVersionSegment(projectSegments[projectSegments.length - 1])) {
            projectSegments.pop(); // Remove the version segment
        }

        if (projectSegments.length > 0 && isFileSegment(projectSegments[projectSegments.length - 1])) {
            projectSegments.pop(); // Remove the last segment if it's a file segment
        }

        let startIndex = getStartDelimiterIndex(projectSegments);

        if (startIndex !== -1) {
            projectSegments = projectSegments.slice(startIndex + 1);
        }

        const resolvedSegments = resolveRelativePath(projectSegments);

        return resolvedSegments.join('/');
    } catch (error) {
        console.error(`Error parsing path: ${error}`);
        throw error;
    }
}

function getStartDelimiterIndex(projectSegments: string[]) {
    let startIndex = -1;

    for (let i = 0; i < projectSegments.length; i++) {
        if (isVersionSegment(projectSegments[i])) {
            startIndex = i;
            break; // Stop after finding a version segment
        } else if (isOrganizationPrefix(projectSegments[i])) {
            startIndex = i;
            // Continue looking for version segments after organization prefix
        }
    }
    return startIndex;
}

function getEndDelimiterIndex(segments: string[]) {
    let endDelimiterIndex = -1;

    for (let i = 0; i < segments.length; i++) {
        const lowerSegment = segments[i].toLowerCase();
        if (END_DELIMITERS.some(delimiter => lowerSegment === delimiter)) {
            endDelimiterIndex = i;
            break;
        }
    }
    return endDelimiterIndex;
}

/**
 * Create path mappings from mapping data
 * @param mappings Array of path mapping objects
 * @returns Map of extracted paths to actual paths
 */
export function createPathMappings(mappings: PathMapping[]): PathMappings {
    const pathMappings = new Map<string, string>();

    for (const mapping of mappings) {
        if (mapping.extractedPath && mapping.actualPath) {
            pathMappings.set(mapping.extractedPath, mapping.actualPath);
        }
    }

    return pathMappings;
}

/**
 * Verify if a project path exists on the file system
 * @param projectPath The extracted project path
 * @param basePath Base directory to check against
 * @param pathMappings Optional path mappings to use for verification
 * @returns Verified path information
 */
export function verifyProjectPath(projectPath: string, basePath: string, pathMappings?: PathMappings): ProjectPathInfo {
    if (!projectPath || !basePath) {
        return { projectPath, verifiedPath: '', projectPathExists: false };
    }

    try {
        const fullPath = path.join(basePath, projectPath);
        const originalExists = fs.existsSync(fullPath);

        if (originalExists) {
            return {
                projectPath,
                verifiedPath: projectPath,
                projectPathExists: true
            };
        }

        if (pathMappings && pathMappings.has(projectPath)) {
            const mappedPath = pathMappings.get(projectPath) as string;
            const mappedFullPath = path.join(basePath, mappedPath);
            const mappedExists = fs.existsSync(mappedFullPath);

            return {
                projectPath,
                verifiedPath: mappedExists ? mappedPath : '',
                projectPathExists: originalExists
            };
        }

        // Try without the first path segment
        const segments = projectPath.split('/');
        if (segments.length > 1) {
            const pathWithoutFirstSegment = segments.slice(1).join('/');
            const modifiedFullPath = path.join(basePath, pathWithoutFirstSegment);
            const modifiedExists = fs.existsSync(modifiedFullPath);

            if (modifiedExists) {
                return {
                    projectPath,
                    verifiedPath: pathWithoutFirstSegment,
                    projectPathExists: false
                };
            }
        }

        // No mapping found or modified path doesn't exist
        return {
            projectPath,
            verifiedPath: '',
            projectPathExists: false
        };
    } catch (error) {
        console.error(`Error verifying project path: ${error}`);
        return { projectPath, verifiedPath: '', projectPathExists: false };
    }
}

/**
 * Extract project information from a dependency path based on origin type
 * @param dependencyPath The path from the Black Duck report
 * @param originName The origin name (e.g., npmjs, maven, nuget, pypi, sbt)
 * @param basePath Optional base path to verify against
 * @returns Object containing project path and verified path information
 */
export function extractProjectInfo(dependencyPath: string, originName: string, basePath?: string, pathMappings?: PathMappings): ProjectPathInfo {
    if (!dependencyPath) {
        return { projectPath: '', verifiedPath: '', projectPathExists: false };
    }

    try {
        const projectPath = parseProjectPath(dependencyPath);

        // Verify the path if basePath is provided
        if (basePath) {
            return verifyProjectPath(projectPath, basePath, pathMappings);
        }

        // Otherwise return unverified path with empty verifiedPath
        return { projectPath, verifiedPath: '', projectPathExists: undefined };
    } catch (error) {
        console.error(`Error extracting project info: ${error}`);
        throw error;
    }
}
