<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/utils

**Role:** Shared low-level helpers — logging, filesystem/home-folder layout, npm invocation,
project-path parsing, and vulnerability lookups used across plugins.

## Files
- `blacklist.ts`
  - `blacklistedGlobs` (const: string[]) — globs read from `.blacklist` in cwd to exclude paths from scanning :6
- `logging.ts`
  - `log` (const: Logger) — shared winston logger, console + `depinder.log` file transport :11
- `npm.ts`
  - `npm` (const) — wraps local npm binary. `install`, `npmCommand` :4
- `utils.ts`
  - `_package` (const) — parsed root `package.json` :8
  - `getAssetFile` (function) — resolves a path under the `assets` dir :11
  - `npmExePath` (const: string) — path to the bundled npm executable :15
  - `depinderFolder`, `depinderTempFolder` (const: string) — `~/.dxw/depinder` home/temp dirs :22
  - `getHomeDir` (function) — ensures depinder home/temp dirs exist, returns home dir :25
  - `walkDir` (function) — recursively lists all files under a directory :35
  - `delay` (function) — promise-based sleep :41
  - `getPackageSemver` (function) — parses a version string into a SemVer, falling back to loose/coerced parsing :45
- `vulnerabilities.ts`
  - `getVulnerabilitiesFromGithub` (function) — queries GitHub GraphQL security advisories for a package :5
  - `getVulnerabilitiesFromSonatype` (function) — batches purls through Sonatype OSS Index for vulnerabilities :76
  - +1 internal helper not listed (mapSeverity)
- `projectMapping.ts`
  - `PathMapping` (interface) — extracted-path/actual-path pair :10
  - `PathMappings` (type) — map of extracted path to actual path :18
  - `ProjectPathInfo` (interface) — parsed project path plus verification result :47
  - `createPathMappings` (function) — builds a `PathMappings` map from an array of `PathMapping` :231
  - `verifyProjectPath` (function) — checks a project path exists on disk, trying mappings and stripped-segment fallbacks :250
  - `extractProjectInfo` (function) — parses a Black Duck dependency path into a project path and (optionally) verifies it on disk :314
  - +9 internal helpers not listed (isVersionSegment, isFileSegment, isOrganizationPrefix, resolveRelativePath, standardizePath, handleMonorepoPattern, parseProjectPath, getStartDelimiterIndex, getEndDelimiterIndex)

## Notes
- `projectMapping.ts` targets Black Duck-report dependency paths specifically; `END_DELIMITERS`
  encodes the package-manager marker segments it splits on (yarn/npm/pip/maven/etc.).
