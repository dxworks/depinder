<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/sbom

**Role:** Turns Syft/Trivy CycloneDX SBOMs into DepinderProjects (one plugin per ecosystem) and
enriches them with a local Trivy+Grype vulnerability scan of the same SBOM file.

## Files
- `index.ts`
  - `sbomJava`, `sbomNpm`, `sbomRuby`, `sbomPython`, `sbomPhp`, `sbomDotnet` (const: Plugin) — the
    six per-ecosystem SBOM plugins :118-123
  - `sbomPlugins` (const: Plugin[]) — all six, for registration and membership checks :125
  - `sbomFilesFor` (function) — which of a file list are SBOMs this plugin set would scan, so
    analyse.ts can preflight scanners before parsing :141
  - `clearSbomCache` (function) — clears the per-file parsed-project cache; test-only :147
  - +7 internal helpers not listed
- `cyclonedx.ts`
  - `CycloneDxComponent`, `CycloneDxBom` (interface) — minimal CycloneDX component/BOM shapes read
    from Syft/Trivy output :26,43
  - `ParsedPurl` (interface) — a purl reduced to {type, name, version} in registrar-matching form :50
  - `parsePurl` (function) — Package URL string to ParsedPurl; maven becomes `groupId:artifactId`,
    npm keeps `@scope/name`; undefined if unparseable :66
  - `parseCycloneDxFile` (function) — parses one SBOM into DepinderProjects filtered to `purlType`;
    resolves Syft per-module vs Trivy application-node project boundaries and the module
    self-anchor exclusion :376
  - +7 internal helpers not listed
- `local-scan.ts`
  - `TrivyReport`, `GrypeReport` (interface) — the subset of each scanner's `sbom` JSON output :39,60
  - `packageKeys` (function) — normalizes purl/name/version into lookup keys + a cross-tool dedup key :96
  - `trivyFindings`, `grypeFindings` (function) — one scanner's report to RawFinding[] :151,186
  - `buildVulnerabilityIndex` (function) — unions and dedupes both tools' findings by (package key,
    canonical vuln id), merging fields by which tool is more reliable for that field, keyed for
    `DepinderDependency.id` lookup :246
  - `PINNED_SCANNER_VERSIONS` (const) — the reference trivy/grype versions :332
  - `ScannerName`, `ScannerStatus`, `ScannerPreflight`, `PreflightMessage` (type/interface) — probe
    result shapes :337-364
  - `preflightScanners` (function) — probes trivy+grype binaries and DBs once per process, never
    throws :436
  - `scannerPreflightMessages`, `scannerSummaryLine` (function) — user-facing log lines on scanner
    availability :462,521
  - `ScannedFileRecord` (interface) — one file's scan outcome for the provenance record :543
  - `PROVENANCE_FILE` (const) — filename `sbom-scan-provenance.json` written per run :553
  - `writeScanProvenance` (function) — writes preflight + per-file outcomes; traces a vulnerability
    count back to its scanner/DB versions :562
  - `LocalScanResult` (interface) — `{available, index}`; `available` true only if a scanner
    actually produced a report :617
  - `scanSbomFileOnce` (function) — runs trivy+grype on one SBOM file, cached once per process :671
  - `clearLocalScanCache` (function) — clears scan cache, provenance records, preflight; test-only :682
  - +17 internal helpers not listed

## Notes
- `parseCycloneDxFile` and `scanSbomFileOnce` are both memoised per file per process; tests must
  call `clearSbomCache`/`clearLocalScanCache` between runs or stale data leaks across cases.
- Missing/failing trivy or grype binaries degrade silently to a log warning, not an error —
  `LocalScanResult.available` is what downstream code must check, never assume scanning ran.
- SBOM plugins share their registrar/checker/ecosystem cache with the native plugin of the same
  ecosystem (see `src/plugins/java` etc.) — enrichment is not fetched twice.
