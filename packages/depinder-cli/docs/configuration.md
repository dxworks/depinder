# Configuration

No configuration file: command-line options, environment variables, and a few files.

## Environment variables

| Variable | Meaning |
|---|---|
| `GH_TOKEN` | GitHub token for per-library advisory lookups (when no SBOM scan answered) and `update`; also a pool of one for `github` |
| `GH_TOKEN_1`, `GH_TOKEN_2`, … | The token pool for `github-advisories`; usually in `.github-tokens` instead |
| `LIBRARIES_IO_API_KEY` | Optional last resort for maven, pypi, nuget and composer packages the registry could not answer; see [Registry fallback](#registry-fallback) |
| `DEPINDER_REGISTRY_LIMITS` | Registry requests at once per ecosystem, e.g. `npm=16,cargo=1:1000`. Same as `--registry-limits`; see [Registry fallback](#registry-fallback) |
| `DEPINDER_CACHE_DB` | SQLite cache path. Default `~/.dxw/depinder/cache/depinder.sqlite` |
| `DEPINDER_CACHE_MAX_AGE` | How old a cached library may be before it is fetched again. Same as `--cache-max-age`. Default `1d` |
| `DEPINDER_PROFILE` | `1` for the same output as `--profile` |
| `DEPINDER_RESOLVER_URL` | Base URL of the bulk purl resolver. Same as `--resolver-url`. Default `https://libs.dxworks.org` |
| `DEPINDER_RESOLVER_TOKEN` | Bearer token for it and for the [vulnerability server](#vulnerability-server). Needed for the resolver; without it packages come from the registries, with a warning |
| `DEPINDER_RESOLVER_MAX_WAIT_MS` | How long one run waits for the resolver in total. Default `60000` |
| `DEPINDER_RESOLVER_CONCURRENCY` | Caps how many 2000-purl chunks are posted at once. Default: all of them |
| `DEPINDER_VULN_MAX_WAIT_MS` | How long one run waits for the [vulnerability server](#vulnerability-server) before scanning locally. Default `30000` |
| `DEPINDER_VULN_CHUNK_SIZE` | Purls per request to the vulnerability server. Default and maximum `5000` |
| `TRIVY_BIN`, `GRYPE_BIN` | Scanner binaries when not on `PATH` |

## Files

| Path | What |
|---|---|
| `~/.dxw/depinder/cache/depinder.sqlite` | The registry cache: `libs`, `misses` |
| `./cache/github-advisories/<ecosystem>.json` | The advisory cache |
| `./.github-tokens` | The token pool: `GH_TOKEN_1=…`, contiguous from 1 |
| `./results/` | Default `-r` |

## Vulnerability sources

`--vuln-source` takes `trivy`, `grype`, `github` or `all`. Default `trivy,grype`.

| Source | Needs |
|---|---|
| `trivy` | `trivy` on `PATH` or `TRIVY_BIN` |
| `grype` | `grype` on `PATH` or `GRYPE_BIN` |
| `github` | Optional. A GitHub token: `.github-tokens` in the folder you run from, or `GH_TOKEN`. The advisories download on the run, or ahead of it with [`github-advisories download`](commands/github-advisories.md) |

### Vulnerability server

With `DEPINDER_RESOLVER_TOKEN` set and `--vuln-source` naming both `trivy` and `grype` (the
default, or `all`), the resolver's server scans the SBOMs with its own Trivy and Grype, and the
local scanners do not run. `github` is still matched locally and merged in.

The local scanners run instead:

- without the token;
- with `--no-vuln-server`, or `--no-resolver` (unless `--vuln-server` is also given);
- when `--vuln-source` leaves out `trivy` or `grype`;
- as a fallback, when the server fails or has not answered in full within
  `DEPINDER_VULN_MAX_WAIT_MS` (default 30 s). The run warns and says why.

## Bulk resolver

On by default. A resolver service answers thousands of package URLs in one call, from its own
store of registry facts, instead of depinder asking each registry package by package. `analyse`
calls the one at `https://libs.dxworks.org`; all it needs is its token, a secret you set once
([how](install.md#4-resolver-token)):

```bash
export DEPINDER_RESOLVER_TOKEN=…
depinder analyse ./repo
```

Without `DEPINDER_RESOLVER_TOKEN`, the run warns once and fetches everything from the registries.
To use another resolver, set `DEPINDER_RESOLVER_URL` or pass `--resolver-url`; to turn it off, pass
`--no-resolver`.

| Setting | Meaning |
|---|---|
| `--resolver-url <url>` / `DEPINDER_RESOLVER_URL` | Where the resolver is; the flag wins over the variable. Default `https://libs.dxworks.org` |
| `DEPINDER_RESOLVER_TOKEN` | Needed for the resolver; without it the run warns once and packages come from the registries |
| `DEPINDER_RESOLVER_MAX_WAIT_MS` | Budget for the whole bulk phase; each request sends what is left of it as `deadline_ms` (at most 60 s). Default `60000` |
| `DEPINDER_RESOLVER_CONCURRENCY` | Caps the chunks in flight at once. Default: every chunk at once; `1` posts one chunk at a time |
| `--no-resolver` | Skip it for this run; no token needed |

Every chunk is posted at once, with one deadline for all of them, so no chunk waits behind another
and each has the whole budget to fetch what the server does not know yet. Each is posted once: there
are no retries. What has not answered by the deadline goes to the registries, and a request that
fails — an error status, a dropped connection, a stream cut short — keeps what it delivered and
turns the resolver off for the rest of the run, with one warning.

Every project is parsed first, every dependency's purl is collected into one list, and the answers
land in the same local cache the registry fallback fills. What the resolver does not know — a package it is
still fetching, one the registry does not have, or anything at all when the server is unreachable —
falls back to the [registries](#registry-fallback), package by package, so a run is never worse than one without it. `--refresh`
still ignores the local cache, but takes its fresh facts from the resolver first.

Each answer is written to the cache the moment it arrives, so a run stopped halfway keeps what had
already come back. The resolver serves registry facts only: GitHub advisories are still fetched per
library with `GH_TOKEN` set, but for a resolver answer only when a project using that library has no
SBOM scan findings — the only case in which they are read.

## Registry fallback

Every package neither the cache nor the resolver answered (or every package, with
`--no-resolver`) is fetched from its registry by the same code the resolver's server runs, so a
package gets the same facts whichever road it came by. The answer is cached locally like a
resolver answer. `depinder update` re-fetches cached rows the same way.

When the registry has no such package or fails, and `LIBRARIES_IO_API_KEY` is set, a **maven**,
**pypi**, **nuget** or **composer** package is asked of [Libraries.io](https://libraries.io)
instead. npm, gem, cargo and Go packages never are. Without the key, the lookup fails and is
remembered as a miss for 24 hours.

How hard each registry is asked is set per purl type: requests in flight at once, and optionally
the minimum milliseconds between two request starts. The numbers change only the speed, never the
facts; a registry answering 429 is waited out (honouring `Retry-After`) and asked again.

| Purl type | Default |
|---|---|
| `golang` | 64 at once (a module costs a request per version) |
| `nuget` | 32 at once (a package can cost several catalogue pages) |
| `npm`, `maven`, `pypi`, `gem`, `cargo`, `composer` | 8 at once |

Override them with `DEPINDER_REGISTRY_LIMITS` or `--registry-limits` (the flag wins per type):
`<type>=<concurrency>[:<minIntervalMs>]`, comma-separated.

```bash
export DEPINDER_REGISTRY_LIMITS=npm=16,maven=4
depinder analyse ./repo --registry-limits cargo=1:1000
```

Raising a type's limit above 8 also lets `analyse` and `update` look up that many of its packages
at once. A bad entry stops the run before anything is fetched, naming the entry and the valid types.
