# Black Duck report tools

Two commands that reshape a **real** Black Duck export — the zip from a project version's
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
| `--repoCategories <path>` | `repo-to-category.csv`; runs the command below afterwards |

Writes `_dependencies.csv`, `_dependencies_sources.csv` (with `VerifiedPath`,
`VerifiedPathMethod`), `_vulnerability_details.csv` and `_upgrade_guidance.csv` into the same
folder. How project paths are extracted: [Project mapping](../project-mapping.md).
[`analyse`](analyse.md) writes the same four files, same headers and cell
conventions, from SBOMs; the shared definition is `src/blackduck/columns.ts`.

## addCategoriesToBlackDuckReports

```
depinder addCategoriesToBlackDuckReports <reportPath> <repoCategoriesPath>
```

Adds the repository's category to every row of `_dependencies.csv` and
`_dependencies_sources.csv`. The repository is the first segment of `VerifiedPath`, or of
`ProjectPath` when no path was verified — which is every row of an `analyse` SBOM subfolder.
The two files are matched on `Version id`; when every `Version id` in both is empty — an
`analyse` subfolder has no Black Duck UUIDs — they are matched on `Component Version Origin Id`.
