# export-blackduck

```
depinder export-blackduck <sbom-folders...> [options]
```

Runs the [`analyse`](analyse.md) SBOM route and writes the Black Duck-shaped files on top.

| Option | Meaning | Default |
|---|---|---|
| `<sbom-folders...>` | Folders to walk for `*.cdx.json` | required |
| `-r, --results <folder>` | Output folder | `results` |
| `--project-name <name>` | `ProjectPath` value and head of every `Path` | SBOM project name |
| `--target <folder>` | The scanned repositories, one per SBOM name; gives `Path` Black Duck's project prefix and drops own code from the chain | off |
| `--refresh` | Ignore the cache | off |
| `--vuln-source <sources>` | `trivy`, `grype`, `github`, `all` | `trivy,grype` |
| `--github-token-file <file>` | Tokens for `github` | `.github-tokens` |
| `--github-max-age <hours>` | Advisory cache freshness | `24` |
| `--profile` | Timings and request counts | off |

## Output

| File | Black Duck counterpart |
|---|---|
| `_dependencies.csv` | `components_*.csv` |
| `_dependencies_sources.csv` | `source_*.csv` |
| `_upgrade_guidance.csv` | `project_version_upgrade_guidance_*.csv` |
| `security.csv` | `security_*.csv` |
| `_dependency_edges.csv` | none — every edge of the graph |
| `_vulnerability_findings.json` | none — the findings as the exporter saw them, fix versions included |
| `_graph_rebuild.json` | none — inputs and hashes the paths were built from |

Columns and derivations: [Black Duck Export](../blackduck-export.md).

## `--target`

Black Duck prefixes every path with `<name>/<version>/<dir>/-<pm>/`, read from the manifest, and
treats the repository's own code as the project. An SBOM has no manifest, so without `--target`
the prefix is `<project-name>/-<pm>/` and own code stays in the chain. With it, `Path` matches
Black Duck's; `ProjectPath` and `_dependency_edges.csv` do not change.

!!! note
    Black Duck's unit is the manifest (83 sub-projects for a pnpm monorepo); ours is the lockfile
    (4). The prefix matches, the row count per project does not.

## Example

```bash
depinder github-advisories download --sbom ./sboms
depinder export-blackduck ./sboms -r exports/my-project \
    --vuln-source trivy,grype,github --project-name my-project --target /path/to/repositories
```
