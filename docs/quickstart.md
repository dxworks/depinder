# Quick Start

A folder of CycloneDX SBOMs in, a folder of CSVs out.

## Prerequisites

- Depinder [installed](install.md).
- A folder of `*.cdx.json` files. A [DepMiner](https://dxworks.org/depminer/) results zip has them
  under `depminer/results/syft/` and `depminer/results/trivy/`.
- Trivy and/or Grype on `PATH`, for vulnerabilities.

## 1. Analyse

```bash
depinder analyse /path/to/sboms -r results
```

Plugins are picked from the purl types in the SBOMs. The first run fills the registry cache;
`--profile` shows where the time went.

## 2. Results

```
results/
  sbom-npm-libs.csv
  sbom-npm-licenses.csv
  sbom-npm-project-stats.csv
  ...                          one triple per ecosystem
  security.csv                 one row per (component, advisory)
  sbom-scan-provenance.json    which scanner ran, at which version
```

## 3. Black Duck-shaped export

```bash
depinder export-blackduck /path/to/sboms -r results --vuln-source trivy,grype,github --project-name my-project
```

Same analysis, plus the [Black Duck files](blackduck-export.md). The `github` source needs a
GitHub token, read from the directory you run the command in: `GH_TOKEN` in the environment,
or a `.github-tokens` file next to you (`--github-token-file` to point elsewhere):

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

## Native route

```bash
depinder analyse /path/to/repo-a /path/to/repo-b -r results -p npm ruby
```

Maven and Gradle need a `deptree.txt` first — see [Configuration](configuration.md#native-route-prep).
