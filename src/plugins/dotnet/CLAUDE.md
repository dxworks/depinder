<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/dotnet

**Role:** .NET/NuGet dependency source — runs NuGet Inspector on csproj/fsproj/vbproj files to
build a DepinderProject and enriches libraries from the NuGet API.

## Files
- `index.ts`
  - `runNugetInspector` (function → Parser.parseDependencyTree) — runs/caches NuGet Inspector
    output for a manifest and parses it into a DepinderProject :88
  - `NugetRegistrar` (class → AbstractRegistrar) — library metadata from api.nuget.org
    (registration5-gz-semver1). `retrieveFromRegistry`, `parseData` :114
  - `registrar` (const: Registrar) — NugetRegistrar chained to NugetRegistrarSemver2 chained to
    LibrariesIORegistrar('nuget') as fallbacks :149
  - `dotnet` (const: Plugin) — plugin descriptor: extractor globs, parser, registrar, checker :151
  - +5 internal helpers not listed

## Notes
- Requires the `@dxworks/nuget-inspector` binary to run against each project's root; results are
  cached as `<manifestFile>.json` next to the manifest and reused on subsequent runs.
