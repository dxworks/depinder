# Depinder

**Depinder** reads a project's dependencies and reports licences, newer versions and known
vulnerabilities. It runs as `depinder` on the command line, or as a `dxw` plugin.

| Route | Input | Produced by |
|---|---|---|
| **SBOM** (recommended) | CycloneDX files, `*.cdx.json` | [DepMiner](https://dxworks.org/depminer/) — Syft and Trivy, offline |
| **Native** | Manifests and lockfiles on disk | The project itself |

The SBOM route is where the recent work is: the dependency graph, upgrade guidance, three
vulnerability sources, and the [Black Duck export](blackduck-export.md).

## Where to go next

<div class="grid cards" markdown>

- :material-download: **[Installing](install.md)** — the CLI and the two scanners.
- :material-rocket-launch: **[Quick Start](quickstart.md)** — SBOMs in, CSVs out.
- :material-console: **[Commands](commands/index.md)** — every command, with its options.
- :material-file-table: **[Black Duck Export](blackduck-export.md)** — the files and every column.
- :material-tune: **[Configuration](configuration.md)** — tokens, cache, environment.

</div>

## Output

Per ecosystem found, three CSVs named after the plugin (`npm`, `ruby`, `java`, `python`, `php`,
`dotnet`, or `sbom-<eco>`):

- `<plugin>-libs.csv` — one row per (project, library, version)
- `<plugin>-licenses.csv` — licences seen, with counts
- `<plugin>-project-stats.csv` — per project: dependency, outdated and vulnerable counts

Each source `analyse` finds — Trivy SBOMs, Syft SBOMs, native manifests — gets its own
subfolder (`trivy/`, `syft/`, `depinder/`). The SBOM subfolders also hold `security.csv`, one
row per (component, advisory), and the [Black Duck-shaped files](blackduck-export.md).

## Ecosystems

| Plugin | Aliases | Native input | SBOM plugin |
|---|---|---|---|
| `npm` | `js`, `javascript`, `node`, `nodejs`, `yarn` | `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` | `sbom-npm` |
| `ruby` | `gem` | `Gemfile.lock` | `sbom-ruby` |
| `java` | `maven`, `gradle` | `pom.xml` / `build.gradle` + `deptree.txt` | `sbom-java` |
| `python` | `pip`, `pipenv`, `poetry` | `requirements.txt`, `Pipfile.lock`, `poetry.lock` | `sbom-python` |
| `php` | `composer` | `composer.lock` | `sbom-php` |
| `dotnet` | `.net`, `c#`, `csharp`, `nuget` | `*.csproj` + `packages.lock.json` | `sbom-dotnet` |
| — | — | — | `sbom-go`, `sbom-rust` |

Registry lookups are cached in `~/.dxw/depinder/cache/depinder.sqlite`, shared by every run on the
machine. When the optional [MongoDB cache](commands/cache.md) is running, it is used instead.
