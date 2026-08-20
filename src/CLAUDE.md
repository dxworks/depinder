<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src

**Role:** Depinder CLI entry point — wires the `depinder` command tree to its
subcommand implementations.

## Files
- `depinder.ts`
  - `mainCommand` (const: Command) — root `depinder` Command; registers `analyse`,
    `update`, `cache`, `extractFrameworkVersions`, `transformBlackDuckReports` :9
- `index.ts` — shebang entrypoint; parses `process.argv` via `mainCommand` :3

## Subdirs
- `assets/` — local-dev infra: Docker Compose + Mongo init script for the cache
  backend. No exported symbols (config/script files).
- `cache/` — pluggable LibraryInfo key-value store. `Cache`, `noCache`, `jsonCache`,
  `mongoCache`, `LibraryInfoModel`
- `commands/` — Commander.js subcommand definitions (analyse, cache,
  extractFrameworkVersion, transformBlackDuckReports, update). `analyseCommand`,
  `cacheCommand`, `extractFrameworkVersionsCommand`,
  `transformBlackDuckReportsCommand`, `updateCommand`, `AnalyseOptions`,
  `createAnalyseCommand`, `analyseFiles`, `transformBlackDuckReports`, `updateLibs`
  +14 more
- `extension-points/` — core plugin contracts: extraction, parsing, registry,
  vulnerability-checking, code-impact. `Extractor`, `Parser`, `DepinderProject`,
  `DepinderDependency`, `Plugin`, `Registrar`, `AbstractRegistrar`, `LibraryInfo`,
  `VulnerabilityChecker`, `Vulnerability` +9 more
- `info/` — per-ecosystem manifest/lockfile parsers feeding dependency enrichment;
  currently only a PHP Composer parser one level deeper, in `info/php/`.
- `plugins/` — loads and resolves the active ecosystem plugin set (native
  manifest-based + SBOM-based). `plugins`, `getPluginsFromNames`; per-ecosystem
  subdirs: dotnet, java, javascript, php, python, ruby, sbom
- `utils/` — shared low-level helpers: logging, home-folder paths, npm wrapper,
  Black Duck path parsing, vulnerability lookups. `log`, `npm`, `getHomeDir`,
  `walkDir`, `getPackageSemver`, `PathMappings`, `extractProjectInfo`,
  `getVulnerabilitiesFromGithub`, `getVulnerabilitiesFromSonatype`,
  `blacklistedGlobs` +10 more

## Notes
- `mainCommand` is the sole aggregation point for subcommands; each `commands/*.ts`
  file only builds its own `Command` — nothing self-registers.
- Plugin identity/order lives in `extension-points/plugin-loader`'s `defaultPlugins`,
  not in `plugins/index.ts`.
