# Quick Start

A folder of CycloneDX SBOMs in, a folder of CSVs out.

## Prerequisites

- Depinder [installed](install.md).
- A folder of CycloneDX SBOMs (`*.cdx.json`, or any `.json` declaring `bomFormat`). A [DepMiner](https://dxworks.org/depminer/) results zip has them
  under `depminer/results/syft/` and `depminer/results/trivy/`.
- Trivy and/or Grype on `PATH`, for vulnerabilities.

## 1. Analyse

```bash
depinder analyse /path/to/depminer/results/trivy /path/to/depminer/results/syft -r results \
    --vuln-source trivy,grype,github --project-name my-project
```

Each file is sorted by its content: a Trivy SBOM or a Syft SBOM; anything else is ignored.
Plugins are picked from the purl types in the SBOMs. `--profile` shows where the time went.

The first run fills the registry cache, and a run within the next day answers from it; after that
the entries are fetched again. `--cache-max-age` changes that window (`90s`, `30m`, `12h`, `7d`),
and `DEPINDER_CACHE_MAX_AGE` sets it for every run:

```bash
# Re-runs over the next week answer from the cache
depinder analyse /path/to/depminer/results/trivy /path/to/depminer/results/syft -r results --cache-max-age 7d

# Everything fetched again now
depinder analyse /path/to/depminer/results/trivy /path/to/depminer/results/syft -r results --cache-max-age 0
```

The `github` source needs a GitHub token, read from the directory you run the command in:
`GH_TOKEN` in the environment, or a `.github-tokens` file next to you (`--github-token-file` to
point elsewhere):

```bash
export GH_TOKEN=ghp_...
# or
echo 'GH_TOKEN_1=ghp_...' > .github-tokens
```

With a token, the run downloads the advisories for the ecosystems in the SBOMs by itself, into
`cache/github-advisories/` under the working directory, and reuses them for 24 hours
(`--github-max-age`). Without one, the refresh is skipped with a warning and `github` contributes
nothing. To fill the cache ahead of time, or to run offline later:

```bash
depinder github-advisories download --sbom /path/to/sboms
```

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
gives a real Black Duck export — see [Black Duck files](blackduck-export.md).
