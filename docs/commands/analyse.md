# analyse

```
depinder analyse [folders...] [options]
```

| Option | Meaning | Default |
|---|---|---|
| `[folders...]` | Project folders (native) or folders of `*.cdx.json` (SBOM) | — |
| `-r, --results <folder>` | Output folder | `results` |
| `-p, --plugins [plugins...]` | Restrict to these plugins, by name or [alias](../index.md#ecosystems) | all |
| `--refresh` | Ignore the cache | off |
| `--vuln-source <sources>` | `trivy`, `grype`, `github`, `all`, comma-separated. SBOM route only | `trivy,grype` |
| `--github-token-file <file>` | Tokens for `github` | `.github-tokens` |
| `--github-max-age <hours>` | Re-download advisories older than this | `24` |
| `--profile` | Phase timings, cache hits, requests per host | off |

## Output

| File | One row per |
|---|---|
| `<plugin>-libs.csv` | (project, library, version): direct or transitive, versions, dates, licence, vulnerability count |
| `<plugin>-licenses.csv` | licence |
| `<plugin>-project-stats.csv` | project |
| `security.csv` | (component, advisory), Black Duck's `security_*.csv` header |
| `sbom-scan-provenance.json` | run: which scanners ran, at which version |

## Routes

=== "SBOM"

    ```bash
    depinder analyse ./sboms -r results --vuln-source trivy,grype,github
    ```

    Plugins come from the purl types in the SBOMs. Trivy and Grype scan each file once; findings
    are unioned by (package, id). Syft SBOMs carry edges only for yarn workspaces and Maven modules;
    Trivy SBOMs carry the graph for every lockfile.

=== "Native"

    ```bash
    depinder analyse ./repo-a ./repo-b -r results -p npm ruby java
    ```

    Reads lockfiles from disk. Maven and Gradle need a `deptree.txt` first
    ([prep](../configuration.md#native-route-prep)). Vulnerabilities come from GitHub per package
    and need `GH_TOKEN`.

## Cache

Registry answers go to `~/.dxw/depinder/cache/depinder.sqlite`; failed lookups too, for 24 hours.
`--refresh` bypasses both. See [cache](cache.md).
