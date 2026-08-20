<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/commands

**Role:** Commander.js CLI command definitions — each file wires a subcommand's flags to its
implementation (analysis, cache lifecycle, framework-version extraction, Black Duck import, DB update).

## Files
- `analyse.ts`
  - `AnalyseOptions` (interface) — CLI options shape for `analyse` :36
  - `createAnalyseCommand` (function) — factory for `analyse` cmd: `[folders...]`, `-r/--results <folder>`, `--refresh`, `-p/--plugins <plugins...>` :43
  - `analyseCommand` (const: Command) — singleton built by `createAnalyseCommand` :57
  - `csvRow` (function) — joins cell values into one CSV row :76
  - `convertDepToRow` (function) — DepinderDependency → CSV row for results output :80
  - `advisoriesMatchingVersion` (function) — filters LibraryInfo vulns to those matching a version :124
  - `resolveVulnerabilities` (function) — vulns applicable to a project dependency :139
  - `analyseFiles` (function) — action handler: walks folders, runs plugins, writes CSVs :197
- `cache.ts`
  - `cacheUpAction`, `cacheDownAction`, `cacheInfoAction`, `cacheInitAction` (function) — docker-compose mongo cache lifecycle :9,13,32,47
  - `getMongoDockerContainerStatus` (function) — reads docker container state for the cache :17
  - `cacheUpCommand` (const: Command) — `cache up` (alias `start`) :55
  - `cacheDownCommand` (const: Command) — `cache down` (alias `stop`) :60
  - `cacheInfoCommand` (const: Command) — `cache info` (alias `i`) :65
  - `cacheInitCommand` (const: Command) — `cache init` :70
  - `cacheCommand` (const: Command) — `cache` parent, defaults to info; subcommands up/down/info/init :74
- `extractFrameworkVersion.ts`
  - `extractFrameworkVersionsCommand` (const: Command) — `extractFrameworkVersion <projectPath> <outputPath>`: .NET/Java version scan of *proj, Maven, Gradle files :264
- `info.ts` — entirely commented out, no active exports (legacy PHP/composer info command)
- `transformBlackDuckReports.ts`
  - `transformUpgradeGuidance` (function) — reformats raw Black Duck upgrade-guidance CSV text :393
  - `transformBlackDuckReports` (function) — action handler: converts Black Duck CSV exports into shareable reports :478
  - `transformBlackDuckReportsCommand` (const: Command) — `transformBlackDuckReports <reportPath>`: `-b/--basePath <path>`, `-m/--pathMappings <path>` :537
- `update.ts`
  - `updateCommand` (const: Command) — `update [updated_before] [plugins...]`: refreshes DB libs :12
  - `updateLibs` (function) — action handler: updates cached library metadata for given plugins :27

## Notes
- `info.ts` exports nothing live; its command is not registered anywhere until uncommented.
