# Project paths in Black Duck reports

[`transformBlackDuckReports`](../commands/blackduck-reports.md#transformblackduckreports) reads the
project each dependency belongs to from its Black Duck `Path`, writes it as `ProjectPath`, and,
with `--basePath`, checks that the folder exists on disk (`VerifiedPath`, `VerifiedPathMethod`).

The project path is what comes before the package-manager tag (`-yarn`, `-npm`, `-maven`,
`-nuget`, `-pip`, …), without a trailing manifest file (`.csproj`, `pom.xml`, `build.gradle`) or
version segment.

## Usage

```shell
depinder transformBlackDuckReports <path-to-reports> --basePath <base-path> --pathMappings <path-to-mappings.json>
```

Or with the short options:

```shell
depinder transformBlackDuckReports <path-to-reports> -b <base-path> -m <path-to-mappings.json>
```

`--basePath` is the folder the repositories are checked out under. Without it nothing is checked
and every row gets `not-checked`. `--pathMappings` is optional.

| `VerifiedPathMethod` | `VerifiedPath` is |
|---|---|
| `exact` | `ProjectPath`, which exists under the base path |
| `mapping` | The `actualPath` the mappings file gives for `ProjectPath` |
| `maven-artifact-parent` | `ProjectPath` without its last segment, when that segment is the Maven artifact name |
| `drop-first-segment` | `ProjectPath` without its first segment |
| `none` | Empty: no candidate exists |
| `not-checked` | Empty: no `--basePath` |

They are tried in that order; the first folder that exists wins. A mapped folder that does not
exist gives `none`; the later ones are not tried.

## Path mappings file

For a project whose folder does not match the extracted path, for example a Maven artifact id that
differs from its folder name:

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

`extractedPath` is the `ProjectPath` value; `actualPath` is relative to `--basePath`. A mapping is
used only when `ProjectPath` itself does not exist.

## Examples

### npm/yarn

```
Input:  "project-name/frontend/-yarn/react/17.0.2"
Output: ProjectPath = "project-name/frontend"
        VerifiedPath = "project-name/frontend" (if it exists on filesystem)
```

### Maven, with a path mapping

```
Input:  "org.example.module:module-api:1.0.0-SNAPSHOT:example-module/module-api:-maven/..."
Output: ProjectPath = "example-module/module-api"
        VerifiedPath = "example-module/api" (if mapping exists and path exists)
```

### .NET

```
Input:  "Portal/1.0.0-/customer/Portal/Self/Self.csproj/-nuget/Chr.Avro/7.1.0"
Output: ProjectPath = "customer/Portal/Self"
        VerifiedPath = "customer/Portal/Self" (if it exists on filesystem)
```

### Python

```
Input:  "my-repo/load_data/-pip/aiosignal/1.3.2"
Output: ProjectPath = "my-repo/load_data"
        VerifiedPath = "my-repo/load_data" (if it exists on filesystem)
```

## Troubleshooting

**No end delimiter found in path.** The transform stops: the `Path` in the message has no
package-manager tag depinder recognises. Check that `source_*.csv` is the file from the Black Duck
zip, unedited. If it is, the path uses a package manager depinder does not know yet;
[open an issue](https://github.com/dxworks/depinder/issues) with the path from the message.

**Project path not found on disk** (`none`). Check that `--basePath` is the folder holding the
repositories. If the extracted path differs from the real folder, add it to the
[path mappings file](#path-mappings-file).
