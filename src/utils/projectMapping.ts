/**
 * Project mapping utilities for extracting project information from dependency paths
 */

const YARN_DELIMITER = '/-yarn/';
const NPM_DELIMITER = '/-npm/';
const NODE_MODULES_DELIMITER = '/node_modules/';
const PIP_DELIMITER = '/-pip/';
const MAVEN_DELIMITER = ':-maven/';
const POM_DELIMITER = 'pom.xml/-maven/';
const CSPROJ_EXTENSION = '.csproj';
const SBT_DELIMITER = ':-sbt/';

// Common regex patterns
const VERSION_PATTERN = /(\d+\.\d+\.\d+)(-|\/)/;
const MONOREPO_PATTERN = /packages[\\\/]([^\\\/]+)[\\\/]local[\\\/]([^\\\/]+)[\\\/]-yarn/;
const SBT_PATTERN = /[\d\.]+(-SNAPSHOT)?:([^:]+):-sbt/;
const VERSION_LIKE_SEGMENT_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Interface representing a parsed project path
 */
export interface ProjectPathInfo {
  projectPath: string;
  verifiedPath: string;
}

/**
 * Resolves a path with relative segments (.., .)
 * @param pathSegments Array of path segments to resolve
 * @returns Array of resolved path segments
 * @example
 * resolveRelativePath(['a', '..', 'b', 'c']) // returns ['a', 'c']
 * resolveRelativePath(['a', 'b', '..', 'c', 'd']) // returns ['a', 'c', 'd']
 * resolveRelativePath(['a', '..', '..', '..', 'b', 'c', 'd', 'e']) // returns ['b', 'd', 'e']
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
 * Standardizes a path by normalizing slashes and removing leading/trailing slashes
 * @param inputPath Path to standardize
 * @returns Standardized path
 * @example
 * standardizePath('/path/to/project/') // returns 'path/to/project'
 */
function standardizePath(inputPath: string): string {
  if (!inputPath) {
    return '';
  }
  
  // Replace backslashes with forward slashes
  let normalizedPath = inputPath.replace(/\\/g, '/');
  
  // Remove leading slash if present
  if (normalizedPath.startsWith('/')) {
    normalizedPath = normalizedPath.substring(1);
  }
  
  // Remove trailing slash if present
  if (normalizedPath.endsWith('/')) {
    normalizedPath = normalizedPath.substring(0, normalizedPath.length - 1);
  }
  
  return normalizedPath;
}

/**
 * Splits a path by a delimiter and returns the part before the delimiter
 * @param inputPath Path to split
 * @param delimiter Delimiter to split by
 * @returns The part of the path before the delimiter, or the original path if delimiter not found
 * @example
 * splitPathByDelimiter('project/path/-yarn/dependency', '/-yarn/') // returns 'project/path'
 */
function splitPathByDelimiter(inputPath: string, delimiter: string): string {
  if (!inputPath || !delimiter) {
    return inputPath || '';
  }
  
  if (inputPath.includes(delimiter)) {
    return inputPath.split(delimiter)[0];
  }
  
  return inputPath;
}

/**
 * Extract project information from a dependency path based on origin type
 * @param dependencyPath The path from the Black Duck report
 * @param originName The origin name (e.g., npmjs, maven, nuget, pypi, sbt)
 * @returns Object containing project path and verified path information
 * @example
 * extractProjectInfo('module/owa/-yarn/babel-eslint/8.2.6', 'npmjs')
 * // returns { projectPath: 'module/owa', verifiedPath: 'module/owa' }
 */
export function extractProjectInfo(dependencyPath: string, originName: string): ProjectPathInfo {
  if (!dependencyPath) {
    return { projectPath: '', verifiedPath: '' };
  }
  
  let projectPath = '';
  
  try {
    switch (originName?.toLowerCase() || '') {
      case 'npmjs':
        projectPath = parseNpmPath(dependencyPath);
        break;
      case 'pypi':
        projectPath = parsePipPath(dependencyPath);
        break;
      case 'maven':
        projectPath = parseMavenPath(dependencyPath);
        break;
      case 'nuget':
        projectPath = parseNugetPath(dependencyPath);
        break;
      default:
        projectPath = parseGenericPath(dependencyPath);
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error extracting project info: ${errorMessage}`);
    
    throw error;
  }
  
  // For now, set verifiedPath to projectPath (will be updated with file system verification)
  const verifiedPath = projectPath;
  
  return {
    projectPath,
    verifiedPath
  };
}

/**
 * Parse npm/yarn dependency path to extract project path
 * @param dependencyPath The path from the Black Duck report
 * @returns Extracted project path
 * @example
 * parseNpmPath('module/owa/-yarn/babel-eslint/8.2.6')
 * // returns 'module/owa'
 */
function parseNpmPath(dependencyPath: string): string {
  try {
    // Standardize the path
    const normalizedPath = standardizePath(dependencyPath);
    
    // Handle complex monorepo patterns with packages subdirectories
    // Example: "packages\package-client-registration-app/local/company-package-client-management/-yarn/yup/0.29.3"
    const monorepoMatch = normalizedPath.match(MONOREPO_PATTERN);
    if (monorepoMatch && monorepoMatch[1] && monorepoMatch[2]) {
      // Return the root project path + packages + subpackage
      // Example: "company-package-client-management/packages/package-client-registration-app"
      const subPackage = monorepoMatch[1];
      const rootProject = monorepoMatch[2];
      return standardizePath(`${rootProject}/packages/${subPackage}`);
    }
    
    // Check for simple delimiter cases first (but only if they don't have version segments)
    if (normalizedPath.includes(YARN_DELIMITER)) {
      return splitPathByDelimiter(normalizedPath, YARN_DELIMITER);
    } 
    
    if (normalizedPath.includes(NODE_MODULES_DELIMITER)) {
      return splitPathByDelimiter(normalizedPath, NODE_MODULES_DELIMITER);
    }
    
    // Handle npm paths with potential version segments
    if (normalizedPath.includes(NPM_DELIMITER)) {
      // Check if this path has version segments that need special handling
      const segments = normalizedPath.split('/');
      const npmIndex = segments.indexOf('-npm');
      
      if (npmIndex > 0) {
        // Look for version-like segments or REPLACE_BY_CI before -npm
        let hasVersionSegment = false;
        for (let i = 0; i < npmIndex; i++) {
          if (segments[i].match(VERSION_LIKE_SEGMENT_PATTERN) || segments[i] === 'REPLACE_BY_CI') {
            hasVersionSegment = true;
            break;
          }
        }
        
        if (hasVersionSegment) {
          return parseNpmPathWithVersionSegments(normalizedPath);
        } else {
          return splitPathByDelimiter(normalizedPath, NPM_DELIMITER);
        }
      }
    }
    
    throw new Error(`Could not determine project path from npm path: ${normalizedPath}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing npm path: ${errorMessage}`);
    throw error;
  }
}

/**
 * Parse npm path with version-like segments
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path
 * @private
 */
function parseNpmPathWithVersionSegments(normalizedPath: string): string {
  const segments = normalizedPath.split('/');
  
  const npmIndex = segments.indexOf('-npm');
  if (npmIndex <= 0) {
    throw new Error(`Invalid npm path format, missing -npm delimiter: ${normalizedPath}`);
  }
  
  // Look for version-like segment (semver or REPLACE_BY_CI)
  let versionIndex = -1;
  for (let i = 0; i < npmIndex; i++) {
    if (segments[i].match(VERSION_LIKE_SEGMENT_PATTERN) || segments[i] === 'REPLACE_BY_CI') {
      versionIndex = i;
      break;
    }
  }
  
  // Case 1: Version found with more segments after it before -npm
  // Example: "@lib/my-client/1.2.3/my-client/test/-npm/..."
  if (versionIndex >= 0 && npmIndex - versionIndex > 1) {
    // Extract segments between version and -npm
    // For paths like "@lib/my-client/1.2.3/my-client/test/-npm/..."
    // we want "my-client/test"
    return segments.slice(versionIndex + 1, npmIndex).join('/');
  }
  
  // Case 2: Version found immediately before -npm
  // Example: "some-api/0.1.0/-npm/..."
  // In this case, the project path is before the version
  if (versionIndex >= 0 && versionIndex === npmIndex - 1 && versionIndex > 0) {
    return segments.slice(0, versionIndex).join('/');
  }
  
  throw new Error(`Could not determine project path from npm path with version segments: ${normalizedPath}`);
}

/**
 * Parse pip dependency path to extract project path
 * @param dependencyPath The path from the Black Duck report
 * @returns Extracted project path
 * @example
 * parsePipPath('my-repo/load_data/-pip/aiosignal/1.3.2')
 * // returns 'my-repo/load_data'
 */
function parsePipPath(dependencyPath: string): string {
  try {
    const normalizedPath = standardizePath(dependencyPath);
    
    if (normalizedPath.includes(PIP_DELIMITER)) {
      return splitPathByDelimiter(normalizedPath, PIP_DELIMITER);
    }
    
    throw new Error(`Could not determine project path from pip path: ${normalizedPath}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing pip path: ${errorMessage}`);
    throw error;
  }
}

/**
 * Parse Maven dependency path to extract project path
 * @param dependencyPath The path from the Black Duck report
 * @returns Extracted project path
 * @example
 * parseMavenPath('org.mycompany.module:transactionmanagement-omod:6.2.0-SNAPSHOT:module/transactionmanagement-omod:-maven/org.mycompany.module:webservices.rest-omod:2.29.0')
 * // returns 'module/transactionmanagement-omod'
 */
function parseMavenPath(dependencyPath: string): string {
  try {
    const normalizedPath = standardizePath(dependencyPath);
    
    // Pattern 1: Handle Scala/sbt paths
    // Example: root:root_3.1:1.1.1-SNAPSHOT:myproject:-sbt/com.myproject:applogic_3.1:latest/...
    if (normalizedPath.includes(SBT_DELIMITER)) {
      return parseSbtPath(normalizedPath);
    }
    
    if (normalizedPath.includes(MAVEN_DELIMITER)) {
      return parseMavenWithCoordinates(normalizedPath);
    }
    
    if (normalizedPath.includes(POM_DELIMITER)) {
      return parseMavenWithPomXml(normalizedPath);
    }
    
    throw new Error(`Could not determine project path from Maven path: ${normalizedPath}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing Maven path: ${errorMessage}`);
    throw error;
  }
}

/**
 * Parse Scala/sbt dependency path to extract project path
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path
 * @private
 */
function parseSbtPath(normalizedPath: string): string {
  const match = normalizedPath.match(SBT_PATTERN);
  if (match && match[2]) {
    return match[2];
  }
  throw new Error(`Could not determine project path from Scala/sbt path: ${normalizedPath}`);
}

/**
 * Parse Maven path with coordinates
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path
 * @private
 */
function parseMavenWithCoordinates(normalizedPath: string): string {
  const parts = normalizedPath.split(MAVEN_DELIMITER);
  // Extract the path part (after the artifact coordinates)
  const pathWithCoordinates = parts[0];
  
  // The path is usually after the last colon in the coordinates
  const colonParts = pathWithCoordinates.split(':');
  if (colonParts.length > 1) {
    return colonParts[colonParts.length - 1];
  }
  return pathWithCoordinates;
}

/**
 * Parse Maven path with pom.xml
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path
 * @private
 */
function parseMavenWithPomXml(normalizedPath: string): string {
  // Remove trailing slash if present
  const path = normalizedPath.split(POM_DELIMITER)[0].replace('/pom.xml', '');
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Parse .NET dependency path to extract project path
 * @param dependencyPath The path from the Black Duck report
 * @returns Extracted project path
 * @example
 * parseNugetPath('Portal/1.0.0-/customer/Portal/Self/Self.csproj/-nuget/Chr.Avro/7.1.0')
 * // returns 'customer/Portal/Self'
 */
function parseNugetPath(dependencyPath: string): string {
  try {
    const normalizedPath = standardizePath(dependencyPath);
    const segments = normalizedPath.split('/');

    let versionIndex = -1;
    let csprojIndex = -1;

    for (let i = 0; i < segments.length; i++) {
      if (segments[i].match(VERSION_PATTERN) && versionIndex === -1) {
        versionIndex = i;
      }
      if (segments[i].includes(CSPROJ_EXTENSION)) {
        csprojIndex = i;
        break;
      }
    }

    if (versionIndex !== -1 && csprojIndex !== -1 && versionIndex < csprojIndex) {
      const pathBetween = segments.slice(versionIndex + 1, csprojIndex);
      const resolvedPath = resolveRelativePath(pathBetween);
      return resolvedPath.join('/');
    }

    throw new Error(`Could not determine project path from .NET path: ${normalizedPath}`);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing nuget path: ${errorMessage}`);
    throw error;
  }
}

/**
 * Generic fallback parser for dependency paths
 * @param dependencyPath The path from the Black Duck report
 * @returns Extracted project path
 * @example
 * parseGenericPath('some/unknown/path/format')
 * // returns 'some/unknown'
 */
function parseGenericPath(dependencyPath: string): string {
  try {
    // Standardize the path
    const normalizedPath = standardizePath(dependencyPath);
    
    // Try special delimiter approach
    const pathFromDelimiters = parseGenericPathByDelimiters(normalizedPath);
    if (pathFromDelimiters) {
      return pathFromDelimiters;
    }
    
    // Try package manager directories approach
    const pathFromPackageManagers = parseGenericPathByPackageManagers(normalizedPath);
    if (pathFromPackageManagers) {
      return pathFromPackageManagers;
    }
    
    // Try project root indicators approach
    const pathFromRootIndicators = parseGenericPathByRootIndicators(normalizedPath);
    if (pathFromRootIndicators) {
      return pathFromRootIndicators;
    }
    
    // If still no match, use path segments analysis
    return parseGenericPathBySegmentAnalysis(normalizedPath);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Error parsing generic path: ${errorMessage}`);
    
    // Re-throw the error to make failures explicit
    throw error;
  }
}

/**
 * Parse generic path by special delimiters
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path or empty string if no delimiter found
 * @private
 */
function parseGenericPathByDelimiters(normalizedPath: string): string {
  // Extract the first segment of the path (up to the first special delimiter)
  const specialDelimiters = ['/-', ':', '/pom.xml', '/.csproj'];
  
  for (const delimiter of specialDelimiters) {
    if (normalizedPath.includes(delimiter)) {
      return splitPathByDelimiter(normalizedPath, delimiter);
    }
  }
  
  return '';
}

/**
 * Parse generic path by package manager directories
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path or empty string if no package manager directory found
 * @private
 */
function parseGenericPathByPackageManagers(normalizedPath: string): string {
  // Check for package manager specific directories that often indicate the end of a project path
  const packageManagerDirs = ['/node_modules', '/packages', '/libs', '/vendor', '/bower_components', '/dist'];
  
  for (const dir of packageManagerDirs) {
    if (normalizedPath.includes(dir)) {
      return splitPathByDelimiter(normalizedPath, dir);
    }
  }
  
  return '';
}

/**
 * Parse generic path by project root indicators
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path or empty string if no root indicator found
 * @private
 */
function parseGenericPathByRootIndicators(normalizedPath: string): string {
  // Look for common build artifacts or config files that indicate a project root
  const projectRootIndicators = ['/package.json', '/pom.xml', '/build.gradle', '/Gemfile', '/requirements.txt', '/Cargo.toml'];
  
  for (const indicator of projectRootIndicators) {
    if (normalizedPath.includes(indicator)) {
      return splitPathByDelimiter(normalizedPath, indicator);
    }
  }
  
  return '';
}

/**
 * Parse generic path by segment analysis
 * @param normalizedPath Normalized path to parse
 * @returns Extracted project path based on segment analysis
 * @private
 */
function parseGenericPathBySegmentAnalysis(normalizedPath: string): string {
  // Split the path into segments
  const segments = normalizedPath.split('/');
  
  // For very short paths, just return as is
  if (segments.length <= 2) {
    return normalizedPath;
  }
  
  // For longer paths, try to identify a logical project boundary
  // Look for version-like segments (numbers and dots) which often separate project path from dependencies
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].match(/^\d+(\.\d+)+$/)) {
      return segments.slice(0, i).join('/');
    }
  }
  
  // If no version-like segment found, throw an error to make the failure explicit
  // This helps identify paths that need specific parsing logic
  throw new Error(`Could not determine project path from: ${normalizedPath}`);
}
