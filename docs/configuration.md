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
| `DEPINDER_RESOLVER_URL` | Base URL of a bulk purl resolver. Same as `--resolver-url`; off when unset |
| `DEPINDER_RESOLVER_TOKEN` | Bearer token for it. Required with the URL: without it the resolver is skipped |
| `DEPINDER_RESOLVER_MAX_WAIT_MS` | How long one run waits for the resolver in total. Default `60000` |
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
| `github` | A token: `GH_TOKEN` in the environment or `.github-tokens` in the working directory. The advisories download on the run, or ahead of it with [`github-advisories download`](commands/github-advisories.md) |

## Bulk resolver

Optional. A resolver service answers thousands of package URLs in one call, from its own store of
registry facts, instead of depinder asking each registry package by package.

```bash
export DEPINDER_RESOLVER_URL=https://resolver.internal
export DEPINDER_RESOLVER_TOKEN=…
depinder analyse ./repo
```

| Setting | Meaning |
|---|---|
| `--resolver-url <url>` / `DEPINDER_RESOLVER_URL` | Where the resolver is. Nothing set, nothing changes |
| `DEPINDER_RESOLVER_TOKEN` | Mandatory with the URL; a missing token warns and skips the resolver |
| `DEPINDER_RESOLVER_MAX_WAIT_MS` | Budget for the whole bulk phase, re-asks included. Default `60000` |
| `--no-resolver` | Skip it for this run |

Every project is parsed first, every dependency's purl is collected into one list, and the answers
land in the same local cache the registrars fill. What the resolver does not know — a package it is
still fetching, one the registry does not have, or anything at all when the server is unreachable —
falls back to the per-package registrars, so a run is never worse than one without it. `--refresh`
still ignores the local cache, but takes its fresh facts from the resolver first.

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
