# analyse

```
depinder analyse [folders...] [options]
```

Walks every folder given and sorts what it finds into sources by **file content**: a CycloneDX
SBOM whose metadata credits Trivy, and one that credits Syft. Everything else is ignored, and one
line says how many files were passed over — CycloneDX SBOMs are depinder's only input. Each source
is analysed on its own and written to its own subfolder of the results folder. A folder can hold
any mix, and both sources are optional: depinder processes whatever it finds.

| Option | Meaning | Default |
|---|---|---|
| `[folders...]` | Folders to walk for CycloneDX SBOMs | — |
| `-r, --results <folder>` | Output folder; one subfolder per source appears under it | `results` |
| `-p, --plugins [plugins...]` | Use these `sbom-*` plugins, by name or [alias](../index.md#ecosystems) (`java` selects `sbom-java`) | from the SBOMs |
| `--project-name <name>` | SBOM sources: `ProjectPath` value and head of every `Path` | the SBOMs' repo name |
| `--target <folder>` | SBOM sources: the scanned repositories, one per SBOM repo name; gives `Path` Black Duck's project prefix and drops own code from the chain | off |
| `--refresh` | Ignore the cache | off |
| `--cache-max-age <duration>` | Cached libraries older than this are fetched again: `90s`, `30m`, `12h`, `7d`; a bare number is seconds | `DEPINDER_CACHE_MAX_AGE`, else `1d` |
| `--vuln-source <sources>` | `trivy`, `grype`, `github`, `all`, comma-separated | `trivy,grype` |
| `--github-token-file <file>` | Tokens for `github`, relative to the working directory; `GH_TOKEN` from the environment when absent | `.github-tokens` |
| `--github-max-age <hours>` | Re-download advisories older than this | `24` |
| `--resolver-url <url>` | A [bulk purl resolver](../configuration.md#bulk-resolver) to ask before the registries; needs `DEPINDER_RESOLVER_TOKEN` | `DEPINDER_RESOLVER_URL` |
| `--no-resolver` | Skip the bulk resolver even when one is configured | off |
| `--profile` | Phase timings, cache hits, requests per host | off |

## Sources

A file is placed by what it says about itself, never by its name or the folder it sits in:

| Source | Recognised by | Subfolder |
|---|---|---|
| Trivy | a JSON file with `"bomFormat": "CycloneDX"` whose `metadata.tools` names `trivy` | `trivy/` |
| Syft | a JSON file with `"bomFormat": "CycloneDX"` whose `metadata.tools` names `syft` | `syft/` |

A `*.cdx.json` is read whatever it holds; any other `*.json` is read when its first bytes
declare a CycloneDX `bomFormat`, so a SBOM saved as `bom.json` is found and `package.json` is
ignored. A CycloneDX file from any other tool, or a `*.cdx.json` that is not a CycloneDX BOM, is
named in a warning and skipped. The repository an SBOM describes is its `metadata.component.name` — both tools
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
```

A subfolder appears only when its source had input.

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

Plugins come from the purl types in the SBOMs; `-p` picks them instead. Trivy and Grype scan each
file once; findings are unioned by (package, id). Syft SBOMs carry edges only for yarn
workspaces and Maven modules; Trivy SBOMs carry the graph for every lockfile.

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

# Only three ecosystems; the old plugin names select sbom-npm, sbom-ruby and sbom-java
depinder analyse ./sboms -r results -p npm ruby java

# Reuse cached registry answers for a week instead of a day
depinder analyse ./sboms -r results --cache-max-age 7d

# Fetch everything again, but still skip lookups that failed in the last 24 hours
depinder analyse ./sboms -r results --cache-max-age 0

# The same window for every run in this shell
export DEPINDER_CACHE_MAX_AGE=12h
```

## Cache

Registry answers go to `~/.dxw/depinder/cache/depinder.sqlite`; failed lookups too, for 24 hours.
An answer older than `--cache-max-age` (default `1d`) is expired and fetched again, the resolver
first. `--refresh` bypasses both. See [cache](cache.md#expiry).

With a [bulk resolver](../configuration.md#bulk-resolver) configured, every purl this run needs is
asked for in one call after parsing and before enrichment, and what comes back fills that same
cache. Anything it cannot answer goes to the registries as usual.
