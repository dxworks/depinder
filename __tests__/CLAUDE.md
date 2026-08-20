<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# __tests__

**Role:** Jest test suite covering the analyse CLI, plugin ecosystem wiring, dependency-tree
parsers, SBOM ingestion/local-scan pipeline, vulnerability lookups, and live registry access.

## Files
- `analyse.cli.test.ts` — analyse command option parsing: `-r`/`--results`, plugin list, `--refresh`.
- `analyse.csv.test.ts` — `csvRow`/`convertDepToRow` quoting of commas, embedded quotes, newlines, undefined cells.
- `analyse.integration.test.ts` — live, local-only run of `analyseFiles` against a real project tree.
- `analyse.vulnerabilities.test.ts` — `advisoriesMatchingVersion` range filtering and `resolveVulnerabilities` scanner-vs-advisory precedence.
- `cache.integration.test.ts` — live, local-only exercise of the cache up/down/init/info CLI actions.
- `dotnet.init.test.ts` — NuGet registrar retrieval and `.csproj`/`.fsproj`/`.vbproj` file-glob matching.
- `init.test.ts` — `walkDir` walks a real directory tree, local-only.
- `js.registry.integration.test.ts` — live npm registry lookup via `retrieveFromNpm`.
- `maven.parser.test.ts` — `parseMavenDependencyTree` on a sample `mvn dependency:tree` output.
- `maven.registry.integration.test.ts` — live Maven Central lookup via `MavenCentralRegistrar`, local-only.
- `php.registry.integration.test.ts` — live Packagist lookup via `PackagistRegistrar`.
- `plugin.ecosystem.test.ts` — `ecosystemOf` cache-namespace fallback, and that each sbom plugin shares its native counterpart's registrar/checker by reference.
- `projectMapping.test.ts` — `extractProjectInfo`/`verifyProjectPath`: deriving a project path from npm/pip/sbt/Maven/.NET dependency-graph node paths across ecosystem-specific delimiters, versions and monorepo layouts.
- `pypi.registry.integration.test.ts` — live PyPI lookup via `pythonRegistrar`.
- `ruby.registry.integration.test.ts` — live RubyGems lookup via `retrieveFormRubyGems`.
- `sbom.cyclonedx.test.ts` — `parsePurl` coordinate extraction, and `parseCycloneDxFile` splitting a CycloneDX SBOM into one or many DepinderProjects for both the Syft (no project nodes) and Trivy (per-manifest application nodes) shapes.
- `sbom.local-scan.test.ts` — `packageKeys`, `trivyFindings`, `grypeFindings` and `buildVulnerabilityIndex` merging/deduping Trivy and Grype scan output into one vulnerability index.
- `sbom.plugin.test.ts` — sbom plugin wiring: `exactVersionVulnerabilities` flag set only when a scanner ran, and each SBOM file scanned exactly once across projects/plugins.
- `sbom.preflight.test.ts` — scanner preflight detection, user-facing preflight messages, and scan-provenance recording, including `sbomFilesFor`.
- `transformBlackDuckReports.test.ts` — `transformUpgradeGuidance` reshapes a Black Duck upgrade-guidance CSV, keeping quoted commas aligned.
- `update.integration.test.ts` — live, local-only run of `updateLibs` refreshing cached library data.
- `vulnerabilities.test.ts` — live `getVulnerabilitiesFromGithub`/`getVulnerabilitiesFromSonatype` lookups across ecosystems.

## Notes
- Files named `*.integration.test.ts` (plus `init.test.ts`, `js/maven/php/pypi/ruby.registry.integration.test.ts`, `dotnet.init.test.ts`) hit real network/filesystem state and mostly gate on `process.env.CI` via `runOnlyLocally` — they are not meant to run in CI.
- `plugin.ecosystem.test.ts`'s second describe block guards a real footgun: sbom and native plugins share one cache namespace only because they use the same registrar and checker by reference; giving the sbom route its own checker would silently corrupt the native route's cached data.
