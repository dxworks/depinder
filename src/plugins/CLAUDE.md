<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins

**Role:** Loads and exposes the full set of ecosystem plugins (native manifest-based, plus SBOM-based) that Depinder runs against a project.

## Files
- `index.ts`
  - `plugins` (const: Plugin[]) — the resolved plugin list, computed once at module load :25
  - `getPluginsFromNames` (function) — filters `plugins` by name or alias; returns all when no names given :27
  - +2 internal helpers not listed

## Subdirs
- `dotnet/` — runs NuGet Inspector on csproj/fsproj/vbproj to build a DepinderProject, enriches from api.nuget.org. `runNugetInspector`, `NugetRegistrar`, `registrar`, `dotnet`
- `java/` — parses a `deptree.txt` Maven dependency tree into a DepinderProject, enriches from Maven Central. `MavenCentralRegistrar`, `java`
- `javascript/` — parses package.json/lockfiles (npm, yarn) into a DepinderProject, enriches from the npm registry. `retrieveFromNpm`, `javascript`
- `php/` — parses composer.json/composer.lock into a DepinderProject, enriches from Packagist. `parseComposerFile`, `parseComposerLockFile`, `PackagistRegistrar`, `php`, `IPackagistPackageSource`, `IPackagistPackageVersionDetails`, `IPackagistMetadataResponse`, `VendorPackageInput`, `getPackageMetadata`, `IPackagistPackageDetails` +4 more
- `python/` — runs pipenv to build a dependency graph (Pipfile only) into a DepinderProject, enriches from PyPI/Libraries.io. `DepTreeEntry`, `pythonRegistrar`, `python`
- `ruby/` — parses Gemfile.lock into a DepinderProject, enriches from RubyGems.org. `retrieveFormRubyGems`, `ruby`
- `sbom/` — parses Syft/Trivy CycloneDX SBOMs into DepinderProjects per ecosystem (no manifest needed) and adds a local Trivy+Grype vulnerability scan of the same SBOM. `sbomJava`, `sbomNpm`, `sbomRuby`, `sbomPython`, `sbomPhp`, `sbomDotnet`, `sbomPlugins`, `sbomFilesFor`, `clearSbomCache`, `CycloneDxComponent` +24 more

## Notes
- Plugin identity/order comes from `defaultPlugins` in `../extension-points/plugin-loader`, not from this directory listing; `plugins.json` is optional and silently yields nothing if absent/invalid.
- `sbom/` plugins reuse the same-ecosystem native plugin's registrar/checker (e.g. `sbomJava` shares `java`'s Maven Central registrar) — enrichment is not duplicated.
- Native plugins each require a real toolchain artifact to produce a non-empty graph (NuGet Inspector, `deptree.txt`, pipenv, lockfiles); `sbom/` plugins instead require an SBOM file and, for vulnerabilities, local trivy/grype binaries.
