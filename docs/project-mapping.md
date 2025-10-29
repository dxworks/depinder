# Project Mapping Documentation

## Overview

The project mapping feature extracts project paths from dependency paths in Black Duck reports and verifies their existence on the filesystem. This document explains how the feature works, how to use it, and how to configure path mappings for special cases.

## Table of Contents

1. [Path Extraction Process](#path-extraction-process)
2. [Technology-Specific Patterns](#technology-specific-patterns)
3. [Path Verification](#path-verification)
4. [Path Mapping Configuration](#path-mapping-configuration)
5. [API Reference](#api-reference)
6. [Examples](#examples)
7. [Troubleshooting](#troubleshooting)

## Path Extraction Process

The project mapping feature uses a unified algorithm to extract project paths from dependency paths across different technology types:

1. **Normalize the path**:
   - Replace backslashes with forward slashes
   - Replace colons with forward slashes (for paths like 'org:artifact:version')
   - Remove leading and trailing slashes

2. **Find end delimiter**:
   - Look for technology-specific end delimiters (`-yarn`, `-npm`, `-maven`, `-nuget`, etc.)
   - Everything before the end delimiter is potentially part of the project path

3. **Process file segments**:
   - If the last segment before the end delimiter is a file (e.g., `.csproj`, `pom.xml`), remove it

4. **Handle version segments**:
   - If the last segment before the end delimiter is a version (e.g., `1.0.0`, `unspecified`), remove it

5. **Extract project path**:
   - Extract segments between the version segment (if found) and the end delimiter

6. **Resolve relative paths**:
   - Handle relative path segments (e.g., `..`) to get the actual project path

## Technology-Specific Patterns

### npm/yarn

- **End delimiters**: `-yarn`, `-npm`, `node_modules`
- **Example**: `"project-name/frontend/-yarn/react/17.0.2"`
- **Extracted path**: `project-name/frontend`

### Maven/Gradle

- **End delimiters**: `-maven`, `-gradle`, `-sbt`
- **Example**: `"org.example.module:module-api:1.0.0-SNAPSHOT:example-module/module-api:-maven/..."`
- **Extracted path**: `example-module/module-api`
- **Note**: Maven paths often include artifact coordinates in the format `groupId:artifactId:version`

### NuGet

- **End delimiters**: `-nuget`
- **Example**: `"Portal/1.0.0-/customer/Portal/Self/Self.csproj/-nuget/Chr.Avro/7.1.0"`
- **Extracted path**: `customer/Portal/Self`
- **Note**: .NET paths often include `.csproj` files which are removed during extraction

### Python

- **End delimiters**: `-pip`
- **Example**: `"my-repo/load_data/-pip/aiosignal/1.3.2"`
- **Extracted path**: `my-repo/load_data`

## Path Verification

After extracting the project path, the system verifies its existence on the filesystem:

1. **Check original path**:
   - Join the base path with the extracted project path
   - Check if this path exists on the filesystem
   - If it exists, set `verifiedPath` to the project path and `projectPathExists` to `true`

2. **Check mapped path** (if original doesn't exist):
   - If path mappings are provided and contain a mapping for the project path
   - Join the base path with the mapped path
   - Check if this path exists on the filesystem
   - If it exists, set `verifiedPath` to the mapped path (but keep `projectPathExists` as `false`)

3. **Handle non-existent paths**:
   - If neither the original nor mapped path exists, set `verifiedPath` to an empty string
   - The `projectPathExists` flag always reflects whether the original path exists

## Path Mapping Configuration

In some cases, the extracted project path may not match the actual filesystem path. For example, a Maven artifact ID might not match the folder name. To handle these cases, you can provide a path mapping configuration file.

### Configuration File Format

The path mapping configuration is a JSON file with the following structure:

```json
{
  "pathMappings": [
    {
      "extractedPath": "example-module/module-api",
      "actualPath": "example-module/api"
    },
    {
      "extractedPath": "path/to/extracted/project",
      "actualPath": "path/to/actual/project"
    }
  ]
}
```

### Usage

To use path mappings when transforming Black Duck reports, use the `--pathMappings` option:

```shell
depinder transformBlackDuckReports <path-to-reports> --basePath <base-path> --pathMappings <path-to-mappings.json>
```

Or with the shorter option format:

```shell
depinder transformBlackDuckReports <path-to-reports> -b <base-path> -m <path-to-mappings.json>
```

## Examples

### npm/yarn Example

```
Input:  "project-name/frontend/-yarn/react/17.0.2"
Output: ProjectPath = "project-name/frontend"
        VerifiedPath = "project-name/frontend" (if it exists on filesystem)
```

### Maven Example with Path Mapping

```
Input:  "org.example.module:module-api:1.0.0-SNAPSHOT:example-module/module-api:-maven/..."
Output: ProjectPath = "example-module/module-api"
        VerifiedPath = "example-module/api" (if mapping exists and path exists)
```

### .NET Example

```
Input:  "Portal/1.0.0-/customer/Portal/Self/Self.csproj/-nuget/Chr.Avro/7.1.0"
Output: ProjectPath = "customer/Portal/Self"
        VerifiedPath = "customer/Portal/Self" (if it exists on filesystem)
```

### Python Example

```
Input:  "my-repo/load_data/-pip/aiosignal/1.3.2"
Output: ProjectPath = "my-repo/load_data"
        VerifiedPath = "my-repo/load_data" (if it exists on filesystem)
```

## Troubleshooting

### Common Issues

1. **No end delimiter found in path**:
   - This error occurs when the path doesn't contain any of the recognized end delimiters
   - Check if the path follows an unexpected format or if a new end delimiter needs to be added

2. **Project path not found on filesystem**:
   - The extracted path doesn't exist on the filesystem
   - Verify that the base path is correct
   - Consider adding a path mapping if the extracted path doesn't match the actual filesystem path
