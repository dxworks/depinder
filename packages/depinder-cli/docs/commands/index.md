# Commands

`depinder <command> --help` lists a command's options.

| Command | What it does | Network |
|---|---|---|
| [`analyse`](analyse.md) | Dependencies, licences, versions, vulnerabilities; writes the CSVs, and the Black Duck files for SBOM input | Resolver and vulnerability server; registries for what they do not answer and for cache entries older than `--cache-max-age` (default `1d`); scanner databases and GitHub advisories when out of date |
| [`github-advisories`](github-advisories.md) | Local cache of GitHub reviewed advisories | GitHub API |
| [`cache`](cache.md) | Inspect the SQLite cache; import legacy JSON | — |
| [`update`](cache.md#update) | Refresh stale libraries in the SQLite cache | Registries; GitHub with `GH_TOKEN` |
| [`transformBlackDuckReports`](blackduck-reports.md) | Reshape a raw Black Duck export | None |
| [`addCategoriesToBlackDuckReports`](blackduck-reports.md) | Add repository categories to it | None |
| [`extractFrameworkVersion`](extract-framework-version.md) | .NET and Java versions per manifest, to CSV | None |
