# Commands

`depinder <command> --help` lists a command's options.

| Command | What it does | Network |
|---|---|---|
| [`analyse`](analyse.md) | Dependencies, licences, versions, vulnerabilities; writes the CSVs | Registries, first run only |
| [`export-blackduck`](export-blackduck.md) | `analyse` over SBOMs, plus the Black Duck files | Same |
| [`github-advisories`](github-advisories.md) | Local cache of GitHub reviewed advisories | GitHub API |
| [`cache`](cache.md) | Inspect the SQLite cache; start and stop MongoDB | Docker |
| [`update`](cache.md#update) | Refresh stale libraries in MongoDB | Registries |
| [`transformBlackDuckReports`](blackduck-reports.md) | Reshape a raw Black Duck export | None |
| [`addCategoriesToBlackDuckReports`](blackduck-reports.md) | Add repository categories to it | None |
| [`extractFrameworkVersion`](extract-framework-version.md) | .NET and Java versions per manifest, to CSV | None |
