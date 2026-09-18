# export-blackduck

```
depinder export-blackduck <sbom-folders...> [options]
```

Runs the [`analyse`](analyse.md) SBOM route and writes the Black Duck-shaped files on top of its
output, in the same folder.

| Option | Meaning | Default |
|---|---|---|
| `<sbom-folders...>` | Folders to walk for `*.cdx.json` | required |
| `-r, --results <folder>` | Output folder | `results` |
| `--project-name <name>` | `ProjectPath` value and head of every `Path` | SBOM project name |
| `--target <folder>` | The scanned repositories, one per SBOM name; gives `Path` Black Duck's project prefix and drops own code from the chain | off |
| `--refresh` | Ignore the cache | off |
| `--vuln-source <sources>` | `trivy`, `grype`, `github`, `all` | `trivy,grype` |
| `--github-token-file <file>` | Tokens for `github`, relative to the working directory; `GH_TOKEN` from the environment when absent | `.github-tokens` |
| `--github-max-age <hours>` | Advisory cache freshness | `24` |
| `--profile` | Timings and request counts | off |

## Output

The four `_*.csv` files have the header line and cell conventions of
[`transformBlackDuckReports`](blackduck-reports.md), so a downstream reader processes a
depinder folder and a transformed Black Duck folder the same way.

| File | Black Duck counterpart |
|---|---|
| `_dependencies.csv` | the transform's `_dependencies.csv`, from `components_*.csv` |
| `_dependencies_sources.csv` | the transform's `_dependencies_sources.csv`, from `source_*.csv` |
| `_vulnerability_details.csv` | the transform's `_vulnerability_details.csv`, from `security_*.csv` |
| `_upgrade_guidance.csv` | the transform's `_upgrade_guidance.csv`, from `project_version_upgrade_guidance_*.csv` |
| `security.csv` | raw `security_*.csv`, header byte for byte |
| `_dependency_edges.csv` | none — every edge of the graph |
| `_component_versions.csv` | none — `Newer Versions` next to our count by version number, `Newer Versions (semver)` |
| `_vulnerability_findings.json` | none — the findings as the exporter saw them, fix versions included |
| `sbom-<eco>-libs.csv`, `sbom-<eco>-licenses.csv`, `sbom-<eco>-project-stats.csv` | none — the [`analyse`](analyse.md#output) triple, one per ecosystem in the SBOMs |
| `sbom-scan-provenance.json` | none — which scanners ran, at which version |

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
