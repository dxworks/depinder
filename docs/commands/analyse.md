# analyse

```
depinder analyse [folders...] [options]
```

Walks every folder given and sorts what it finds into sources by **file content**: a CycloneDX
SBOM whose metadata credits Trivy, one that credits Syft, and everything else — lockfiles and
manifests for the native plugins. Each source is analysed on its own and written to its own
subfolder of the results folder. A folder can hold any mix, and the three sources are all
optional: depinder processes whatever it finds.

| Option | Meaning | Default |
|---|---|---|
| `[folders...]` | Project folders (native), folders of `*.cdx.json` (SBOM), or both | — |
| `-r, --results <folder>` | Output folder; one subfolder per source appears under it | `results` |
| `-p, --plugins [plugins...]` | Restrict to these plugins, by name or [alias](../index.md#ecosystems) | all |
| `--project-name <name>` | SBOM sources: `ProjectPath` value and head of every `Path` | the SBOMs' repo name |
| `--target <folder>` | SBOM sources: the scanned repositories, one per SBOM repo name; gives `Path` Black Duck's project prefix and drops own code from the chain | off |
| `--refresh` | Ignore the cache | off |
| `--vuln-source <sources>` | `trivy`, `grype`, `github`, `all`, comma-separated. SBOM sources only | `trivy,grype` |
| `--github-token-file <file>` | Tokens for `github`, relative to the working directory; `GH_TOKEN` from the environment when absent | `.github-tokens` |
| `--github-max-age <hours>` | Re-download advisories older than this | `24` |
| `--profile` | Phase timings, cache hits, requests per host | off |

## Sources

A file is placed by what it says about itself, never by its name or the folder it sits in:

| Source | Recognised by | Subfolder |
|---|---|---|
| Trivy | `*.cdx.json` whose `metadata.tools` names `trivy` | `trivy/` |
| Syft | `*.cdx.json` whose `metadata.tools` names `syft` | `syft/` |
| native | any other file a native plugin reads (`package-lock.json`, `Gemfile.lock`, `pom.xml`, ...) | `depinder/` |

A `*.cdx.json` from any other tool, or one that is not a CycloneDX BOM, is named in a warning
and skipped. The repository an SBOM describes is its `metadata.component.name` — both tools
write the scanned directory's name there — with the file name as fallback. When one producer
describes the same repository twice, both files are analysed and a warning says so.

## Output

```
results/
  trivy/                       what the Trivy SBOMs gave
    sbom-npm-libs.csv
    sbom-npm-licenses.csv
    sbom-npm-project-stats.csv
    ...                        one triple per ecosystem in the SBOMs
    _dependencies.csv          the Black Duck-shaped files, see below
    _dependencies_sources.csv
    _vulnerability_details.csv
    _upgrade_guidance.csv
    security.csv
    _dependency_edges.csv
    _component_versions.csv
    _vulnerability_findings.json
    sbom-scan-provenance.json  which scanners ran, at which version; which tool wrote each SBOM
  syft/                        the same set, from the Syft SBOMs
  depinder/                    what the native plugins gave
    npm-libs.csv
    npm-licenses.csv
    npm-project-stats.csv
    ...                        one triple per native plugin, empty when it found nothing
```

A subfolder appears only when its source had input.

=== "SBOM sources"

    | File | One row per |
    |---|---|
    | `sbom-<eco>-libs.csv` | (project, library, version): direct or transitive, versions, dates, licence, vulnerability count |
    | `sbom-<eco>-licenses.csv` | licence |
    | `sbom-<eco>-project-stats.csv` | project |
    | `_dependencies.csv` | (component, version, origin) — the transform's 25 columns |
    | `_dependencies_sources.csv` | (component, path) — the transform's 23 columns |
    | `_vulnerability_details.csv` | (component, advisory) — the transform's 23 columns |
    | `_upgrade_guidance.csv` | component with a finding |
    | `security.csv` | (component, advisory), Black Duck's raw `security_*.csv` header |
    | `_dependency_edges.csv` | (parent, child) — every edge of the graph |
    | `_component_versions.csv` | component — `Newer Versions` next to `Newer Versions (semver)` |
    | `_vulnerability_findings.json` | component with a finding — the findings as seen, fix versions included |
    | `sbom-scan-provenance.json` | run |

    The four `_*.csv` files have the header line and cell conventions of
    [`transformBlackDuckReports`](blackduck-reports.md), so a downstream reader processes a
    depinder subfolder and a transformed Black Duck folder the same way. Columns and derivations:
    [Black Duck Export](../blackduck-export.md).

    Plugins come from the purl types in the SBOMs; `-p` narrows them. Trivy and Grype scan each
    file once; findings are unioned by (package, id). Syft SBOMs carry edges only for yarn
    workspaces and Maven modules; Trivy SBOMs carry the graph for every lockfile.

=== "Native source"

    | File | One row per |
    |---|---|
    | `<plugin>-libs.csv` | (project, library, version) |
    | `<plugin>-licenses.csv` | licence |
    | `<plugin>-project-stats.csv` | project |

    Reads lockfiles from disk. Maven and Gradle need a `deptree.txt` first
    ([prep](../configuration.md#native-route-prep)). Vulnerabilities come from GitHub per package
    and need `GH_TOKEN`. No Black Duck-shaped files and no `security.csv`: those describe SBOMs.

## `--target`

Black Duck prefixes every path with `<name>/<version>/<dir>/-<pm>/`, read from the manifest, and
treats the repository's own code as the project. An SBOM has no manifest, so without `--target`
the prefix is `<project-name>/-<pm>/` and own code stays in the chain. With it, `Path` matches
Black Duck's; `ProjectPath` and `_dependency_edges.csv` do not change. The repositories are
looked up under `--target` by each SBOM's repository name.

!!! note
    Black Duck's unit is the manifest (83 sub-projects for a pnpm monorepo); ours is the lockfile
    (4). The prefix matches, the row count per project does not.

## Examples

```bash
# A DepMiner results folder: Trivy and Syft SBOMs side by side, one run, two subfolders
depinder analyse ./depminer/results/trivy ./depminer/results/syft -r results --vuln-source trivy,grype,github

# One repository, Black Duck's exact paths
depinder analyse ./sboms -r exports/my-project --project-name my-project --target /path/to/repositories

# Native
depinder analyse ./repo-a ./repo-b -r results -p npm ruby java
```

## Cache

Registry answers go to `~/.dxw/depinder/cache/depinder.sqlite`; failed lookups too, for 24 hours.
`--refresh` bypasses both. See [cache](cache.md).
