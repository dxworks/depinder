# Quick Start

A folder of CycloneDX SBOMs in, a folder of CSVs out.

## Prerequisites

- Depinder [installed](install.md).
- A folder of CycloneDX SBOMs (`*.cdx.json`, or any `.json` declaring `bomFormat`). A [DepMiner](https://dxworks.org/depminer/) results zip has them
  under `depminer/results/syft/` and `depminer/results/trivy/`. The DepMiner results are all you
  need: the manifests Black Duck's paths take their prefix from are in
  [its index](commands/analyse.md#the-depminer-index), so the scanned repositories are not.
- Trivy and/or Grype on `PATH`, for vulnerabilities.
- Optionally, `DEPINDER_RESOLVER_TOKEN` set, for our server (see [Installing](install.md#4-resolver-token-optional)).

!!! tip "No token? No problem"
    Depinder works fully locally without the token: package data comes from the registries and
    vulnerabilities from your local Trivy and Grype. The results are the same; the run is only
    slower.

## 1. Analyse

```bash
depinder analyse /path/to/depminer/results -r results \
    --vuln-source trivy,grype,github --project-name my-project
```

Each file is sorted by its content: a Trivy SBOM or a Syft SBOM; anything else is ignored.
Plugins are picked from the purl types in the SBOMs. `--profile` shows where the time went.

The first run fills the registry cache, and a run within the next day answers from it; after that
the entries are fetched again. `--cache-max-age` changes that window (`90s`, `30m`, `12h`, `7d`),
and `DEPINDER_CACHE_MAX_AGE` sets it for every run:

```bash
# Re-runs over the next week answer from the cache
depinder analyse /path/to/depminer/results -r results --cache-max-age 7d

# Everything fetched again now
depinder analyse /path/to/depminer/results -r results --cache-max-age 0
```

To start from an empty cache without touching the shared one, give the run a database of its own
with `DEPINDER_CACHE_DB`; the file is created on first use, and deleting it empties it again.
`--profile` prints at the end where the time went:

```bash
DEPINDER_CACHE_DB=./run.sqlite depinder analyse /path/to/depminer/results -r results --profile
```

The `github` source is optional. The Trivy and Grype databases already include GitHub's
advisories, so it adds a third view of the same data. To use it, create a GitHub token with no
scopes at [github.com/settings/tokens](https://github.com/settings/tokens) (public advisory data
needs none), and either put it in a `.github-tokens` file in the folder you run depinder from, or
set `GH_TOKEN` (`--github-token-file` points elsewhere; a key the file lacks is read from the
environment):

```bash
echo 'GH_TOKEN_1=ghp_...' > .github-tokens
# or
export GH_TOKEN=ghp_...
```

With a token, the run downloads the advisories for the ecosystems in the SBOMs by itself, into
`cache/github-advisories/` in the folder you run from, and reuses them for 24 hours
(`--github-max-age`). Without one, the refresh is skipped with a warning and `github` contributes
nothing. To fill the cache ahead of time, or to run offline later:

```bash
depinder github-advisories download --sbom /path/to/sboms
```

### Resolver and registry options

`analyse` asks the [bulk resolver](configuration.md#bulk-resolver) at `https://libs.dxworks.org`
first, and the registries only for what it could not answer. It needs `DEPINDER_RESOLVER_TOKEN`:
without it the run warns once and uses the registries alone. These options change that:

| Option | What it does | Without it |
|---|---|---|
| `--resolver-url <url>` | Ask this resolver instead; needs `DEPINDER_RESOLVER_TOKEN` | `DEPINDER_RESOLVER_URL`, else `https://libs.dxworks.org` |
| `--no-resolver` | Skip the resolver; fetch everything from the registries | the resolver is used whenever the token is set |
| `--vuln-server` | With `--no-resolver`: still let the [vulnerability server](configuration.md#vulnerability-server) scan the SBOMs | `--no-resolver` turns that off too |
| `--no-vuln-server` | Keep the resolver, but scan the SBOMs with the local Trivy and Grype | the [vulnerability server](configuration.md#vulnerability-server) scans them |
| `--registry-limits <limits>` | Registry requests at once per ecosystem, optional gap in ms: `npm=16,cargo=1:1000` | 8 at once (`golang` 64, `nuget` 32) |
| `--cache-max-age <duration>` | Re-fetch cached packages older than this (see above) | `1d` |

Every option is in [`analyse`](commands/analyse.md).

## 2. Results

One subfolder per source found, each complete on its own:

```
results/
  trivy/
    sbom-npm-libs.csv
    sbom-npm-licenses.csv
    sbom-npm-project-stats.csv
    ...                          one triple per ecosystem
    _dependencies.csv            the Black Duck-shaped files
    _dependencies_sources.csv
    _vulnerability_details.csv
    _upgrade_guidance.csv
    security.csv                 one row per (component, advisory)
    _dependency_edges.csv
    _component_versions.csv
    _vulnerability_findings.json
    sbom-scan-provenance.json    which scanner ran, at which version; which tool wrote each SBOM
  syft/
    ...                          the same, from the Syft SBOMs
```

The four `_*.csv` files have the exact shape [`transformBlackDuckReports`](commands/blackduck-reports.md)
gives a real Black Duck export — see [Black Duck files](blackduck-export/index.md).
