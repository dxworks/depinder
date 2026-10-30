# analyse

```
depinder analyse [folders...] [options]
```

Walks every folder given and sorts what it finds into sources by **file content**: a CycloneDX
SBOM whose metadata credits Trivy, and one that credits Syft. Everything else is ignored, and one
line says how many files were passed over — CycloneDX SBOMs are depinder's only input. Each source
is analysed on its own and written to its own subfolder of the results folder. A folder can hold
any mix, and both sources are optional: depinder processes whatever it finds.

Package facts come from the [bulk resolver](../configuration.md#bulk-resolver) at
`https://libs.dxworks.org` first, and from the registries for what it does not answer. The resolver
needs its token in `DEPINDER_RESOLVER_TOKEN`, a secret set once in your shell
([how](../install.md#4-resolver-token-optional)); without it every package comes from the registries.

| Option | Meaning | Default |
|---|---|---|
| `[folders...]` | Folders to walk for CycloneDX SBOMs | — |
| `-r, --results <folder>` | Output folder; one subfolder per source appears under it | `results` |
| `-p, --plugins [plugins...]` | Use these `sbom-*` plugins, by name or [alias](../index.md#ecosystems) (`java` selects `sbom-java`) | from the SBOMs |
| `--depminer-index <file>` | DepMiner index file or its folder for manifest-based own-code filtering | discovered beside input |
| `--no-depminer-index` | Disable manifest-based own-code filtering | off |
| `--refresh` | Ignore the cache | off |
| `--cache-max-age <duration>` | Cached libraries older than this are fetched again: `90s`, `30m`, `12h`, `7d`; a bare number is seconds | `DEPINDER_CACHE_MAX_AGE`, else `1d` |
| `--vuln-source <sources>` | `trivy`, `grype`, `github`, `all`, comma-separated | `trivy,grype` |
| `--github-token-file <file>` | Tokens for `github`, relative to the working directory; `GH_TOKEN` from the environment when absent | `.github-tokens` |
| `--github-max-age <hours>` | Re-download advisories older than this | `24` |
| `--resolver-url <url>` | The [bulk purl resolver](../configuration.md#bulk-resolver) to ask before the registries; needs `DEPINDER_RESOLVER_TOKEN` | `DEPINDER_RESOLVER_URL`, else `https://libs.dxworks.org` |
| `--no-resolver` | Skip the bulk resolver, which is on by default; also skips the [vulnerability server](../configuration.md#vulnerability-server) unless `--vuln-server` | off |
| `--vuln-server` | With `--no-resolver`: still let the [vulnerability server](../configuration.md#vulnerability-server) scan the SBOMs; needs `DEPINDER_RESOLVER_TOKEN` | off |
| `--no-vuln-server` | Keep the resolver for packages, but scan the SBOMs with the local Trivy and Grype instead of the [vulnerability server](../configuration.md#vulnerability-server) | off |
| `--registry-limits <limits>` | Registry requests at once per ecosystem, with an optional gap in ms: `npm=16,cargo=1:1000`; see [registry fallback](../configuration.md#registry-fallback) | `DEPINDER_REGISTRY_LIMITS`, else 8 at once (`golang` 64, `nuget` 32) |
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
| `_dependencies_sources.csv` | (component, path) — the transform's 23 columns plus `ProjectFilePath` |
| `_vulnerability_details.csv` | (component, advisory) — the transform's 22 columns |
| `_upgrade_guidance.csv` | component with a finding |
| `_dependency_edges.csv` | (parent, child) — every edge of the graph |
| `_component_versions.csv` | component — `Newer Versions` next to `Newer Versions (semver)` |
| `_vulnerability_findings.json` | component with a finding — the findings as seen, fix versions included |
| `sbom-scan-provenance.json` | run |

The four `_*.csv` files follow the cell conventions of
[`transformBlackDuckReports`](blackduck-reports.md). `_dependencies_sources.csv` adds
`ProjectFilePath` to the transform's columns. Columns and derivations:
[Black Duck Export](../blackduck-export/index.md).

`ProjectFilePath` combines the SBOM's repository and manifest path, for example
`example-service/api/Pipfile.lock`. `ProjectPath` is its parent directory, `example-service/api`.
When no manifest location is recorded, `ProjectFilePath` is empty and `ProjectPath` is the repository name.

For path verification after analysis, use [`verifyPaths`](blackduck-reports.md#verifypaths).

`Path` follows the SBOM dependency graph with a `<repo>/<module>/-<pm>/` prefix. Project anchors
identified by the SBOM are omitted. Repository manifests can identify additional own packages
to omit from source paths, as described below.

Plugins come from the purl types in the SBOMs; `-p` picks them instead. Trivy and Grype scan each
file once; findings are unioned by (package, id). Syft SBOMs carry edges only for yarn
workspaces and Maven modules; Trivy SBOMs carry the graph for every lockfile.

## The DepMiner index

DepMiner keeps flat copies of harvested manifests and lockfiles in `depminer/results/depminer/`.
Its `index.json` maps each copy back to `<repo>/<path>`. The DepMiner results are all `analyse`
needs for own-code filtering; no access to the scanned repositories is required. Each SBOM uses
the manifests listed under its repository name.

`analyse` uses those manifests to match own packages by ecosystem, name and version.
A manifest without a version matches by name. Matched packages are omitted from
`_dependencies_sources.csv` rows and chains; the shortened chain determines each source row's
direct/transitive classification.
This filtering leaves other reports, `ProjectFilePath`, `ProjectPath` and `_dependency_edges.csv` unchanged.

The index is discovered by looking for `depminer/index.json` from each SBOM's directory
upwards to the parent of the input folder. `--depminer-index` selects a file or its containing
folder; `--no-depminer-index` disables lookup. Without manifests, only SBOM anchors are omitted.
Both `depminer/results` and `depminer/results/syft` find `depminer/results/depminer/index.json`.
The path prefix always uses the repository and module directory.

## Examples

```bash
# A DepMiner results folder: Trivy and Syft SBOMs side by side, one run, two subfolders
depinder analyse ./depminer/results/trivy ./depminer/results/syft -r results --vuln-source trivy,grype,github

# Standalone CycloneDX SBOMs
depinder analyse ./sboms -r exports/my-project

# SBOMs copied away from DepMiner results: name the index to retain own-code filtering
depinder analyse ./sboms -r exports/my-project --depminer-index ./depminer/results/depminer

# Only three ecosystems; the aliases select sbom-npm, sbom-ruby and sbom-java
depinder analyse ./sboms -r results -p npm ruby java

# Reuse cached registry answers for a week instead of a day
depinder analyse ./sboms -r results --cache-max-age 7d

# Fetch everything again, but still skip lookups that failed in the last 24 hours
depinder analyse ./sboms -r results --cache-max-age 0

# The same window for every run in this shell
export DEPINDER_CACHE_MAX_AGE=12h

# No resolver: twice the npm requests at once, crates.io one request a second
depinder analyse ./sboms -r results --no-resolver --registry-limits npm=16,cargo=1:1000
```

## Cache

Registry answers go to `~/.dxw/depinder/cache/depinder.sqlite`; failed lookups too, for 24 hours.
An answer older than `--cache-max-age` (default `1d`) is expired and fetched again, the resolver
first. `--refresh` bypasses both. See [cache](cache.md#expiry).

With `DEPINDER_RESOLVER_TOKEN` set, every purl the cache cannot answer is asked of the
[bulk resolver](../configuration.md#bulk-resolver) after parsing and before enrichment — once per run, even when a Trivy and a Syft
source both name it, and with no retries — and what comes back fills that same cache. Anything it
does not answer before its deadline goes to the registries as usual, through the
[registry fallback](../configuration.md#registry-fallback): the server's own fetch code, then
Libraries.io for maven, pypi, nuget and composer when `LIBRARIES_IO_API_KEY` is set.
