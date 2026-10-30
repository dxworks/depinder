# Black Duck report tools

Commands that reshape a **real** Black Duck export — the zip from a project version's
*Reports* page — so it can be shared and joined with repository metadata.

## transformBlackDuckReports

```
depinder transformBlackDuckReports <reportPath> [options]
```

| Option | Meaning |
|---|---|
| `<reportPath>` | Unzipped export; needs `components_*.csv`, `source_*.csv`, `security_*.csv`, `project_version_upgrade_guidance_*.csv` |
| `-b, --basePath <path>` | Root under which project paths are verified on disk |
| `-m, --pathMappings <path>` | JSON mapping Black Duck project paths to real ones |
| `--repoCategories <path>` | `repo-to-category.csv`; adds category reports afterward |

Writes `_dependencies.csv`, `_dependencies_sources.csv` (with `VerifiedPath`,
`VerifiedPathMethod`), `_vulnerability_details.csv` and `_upgrade_guidance.csv` into the same
folder. How project paths are found and verified: [Project paths in Black Duck reports](../blackduck-export/project-mapping.md).
[`analyse`](analyse.md) writes the same four files from SBOMs, using the same cell
conventions and adding `ProjectFilePath` to `_dependencies_sources.csv`.

## verifyPaths

```shell
depinder verifyPaths ./results --basePath ./code-stubs
```

Rechecks `_dependencies_sources.csv` in place. Accepts report folder or `analyse` output root,
including immediate `trivy/` and `syft/` subfolders. Same options as transform; `--basePath` required.

Preserves `ProjectPath` and other fields. Reruns replace stale verification results.
`--repoCategories` rebuilds category reports; omitted → existing category reports untouched.
Both commands reject invalid config before writing; unmatched paths succeed.

## addCategoriesToBlackDuckReports

```
depinder addCategoriesToBlackDuckReports <reportPath> <repoCategoriesPath>
```

Adds the repository's category to every row of `_dependencies.csv` and
`_dependencies_sources.csv`. The repository is the first segment of `VerifiedPath`, or of
`ProjectPath` when no path was verified.
The two files are matched on `Version id`; when every `Version id` in both is empty — an
`analyse` subfolder has no Black Duck UUIDs — they are matched on `Component Version Origin Id`.
