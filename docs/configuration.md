# Configuration

No configuration file: command-line options, environment variables, and a few files.

## Environment variables

| Variable | Meaning |
|---|---|
| `GH_TOKEN` | GitHub token for the native route and `update`; also a pool of one for `github` |
| `GH_TOKEN_1`, `GH_TOKEN_2`, … | The token pool for `github-advisories`; usually in `.github-tokens` instead |
| `LIBRARIES_IO_API_KEY` | Optional fallback for release dates and versions |
| `DEPINDER_CACHE_DB` | SQLite cache path. Default `~/.dxw/depinder/cache/depinder.sqlite` |
| `MONGO_URI`, `MONGO_USER`, `MONGO_PASSWORD` | MongoDB cache. Default `mongodb://localhost:27018/depinder`, `root` |
| `DEPINDER_PROFILE` | `1` for the same output as `--profile` |
| `TRIVY_BIN`, `GRYPE_BIN` | Scanner binaries when not on `PATH` |

## Files

| Path | What |
|---|---|
| `~/.dxw/depinder/cache/depinder.sqlite` | The registry cache: `libs`, `misses` |
| `~/.dxw/depinder/cache/docker-compose.yml` | MongoDB setup, written by `cache init` |
| `./cache/github-advisories/<ecosystem>.json` | The advisory cache |
| `./.github-tokens` | The token pool: `GH_TOKEN_1=…`, contiguous from 1 |
| `./plugins.json` | Extra plugins: `[{"path": "<module>", "field": "<export>"}]` |
| `./results/` | Default `-r` |

`./cache/libs.json` is the previous layout; `depinder cache import cache` moves it into the database.

## Vulnerability sources

`--vuln-source` takes `trivy`, `grype`, `github` or `all`. Default `trivy,grype`.

| Source | Needs |
|---|---|
| `trivy` | `trivy` on `PATH` or `TRIVY_BIN` |
| `grype` | `grype` on `PATH` or `GRYPE_BIN` |
| `github` | `depinder github-advisories download` |

## Native route prep

=== "Maven"

    ```bash
    mvn dependency:tree -DoutputFile=deptree.txt
    ```

=== "Gradle"

    ```bash
    gradle dependencies --configuration compileClasspath > deptree.txt
    ```

Run in each project, or the root project when it has modules. Or skip the native route: a
[DepMiner](https://dxworks.org/depminer/) run produces SBOMs for every ecosystem.
