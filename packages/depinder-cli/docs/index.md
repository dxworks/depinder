# Depinder

**Depinder** reads a project's dependencies and reports licences, newer versions and known
vulnerabilities. It runs as `depinder` on the command line, or as a `dxw` plugin.

| Input | Produced by |
|---|---|
| CycloneDX SBOMs, `*.cdx.json` or any `.json` declaring `bomFormat` | [DepMiner](https://dxworks.org/depminer/) — Syft and Trivy, offline |

SBOMs are the only input: lockfiles and manifests are not parsed. From them come the dependency
graph, upgrade guidance, three vulnerability sources, and the [Black Duck export](blackduck-export.md).

## Where to go next

<div class="grid cards" markdown>

- :material-download: **[Installing](install.md)** — the CLI and the two scanners.
- :material-rocket-launch: **[Quick Start](quickstart.md)** — SBOMs in, CSVs out.
- :material-console: **[Commands](commands/index.md)** — every command, with its options.
- :material-file-table: **[Black Duck Export](blackduck-export.md)** — the files and every column.
- :material-tune: **[Configuration](configuration.md)** — tokens, cache, environment.

</div>

## Output

Per ecosystem found, three CSVs named after the plugin, `sbom-<eco>`:

- `<plugin>-libs.csv` — one row per (project, library, version)
- `<plugin>-licenses.csv` — licences seen, with counts
- `<plugin>-project-stats.csv` — per project: dependency, outdated and vulnerable counts

Each source `analyse` finds — Trivy SBOMs, Syft SBOMs — gets its own subfolder (`trivy/`,
`syft/`). Each also holds `security.csv`, one row per (component, advisory), and the
[Black Duck-shaped files](blackduck-export.md).

## Ecosystems

| Plugin | purl type | Aliases for `-p` |
|---|---|---|
| `sbom-npm` | `npm` | `sbom-npm`, `npm`, `js`, `javascript`, `node`, `nodejs`, `yarn` |
| `sbom-ruby` | `gem` | `sbom-gem`, `ruby`, `gem` |
| `sbom-java` | `maven` | `sbom-maven`, `java`, `maven`, `gradle` |
| `sbom-python` | `pypi` | `sbom-pypi`, `python`, `pip`, `pipenv`, `poetry` |
| `sbom-php` | `composer` | `sbom-composer`, `php`, `composer` |
| `sbom-dotnet` | `nuget` | `sbom-nuget`, `dotnet`, `.net`, `c#`, `csharp`, `nuget` |
| `sbom-go` | `golang` | `sbom-golang` |
| `sbom-rust` | `cargo` | `sbom-cargo` |

Registry lookups are [cached](commands/cache.md) in `~/.dxw/depinder/cache/depinder.sqlite`, shared
by every run on the machine, and fetched again once they are older than a day (`--cache-max-age`).
