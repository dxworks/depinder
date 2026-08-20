<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/extension-points

**Role:** Core interfaces every plugin implements — extraction, parsing, registry lookup,
vulnerability checking, and code-impact analysis for a dependency ecosystem.

## Files
- `code-impact.ts`
  - `CodeFinder` (interface) — locates code-level references to a project's dependencies. `getDeclaredEntities`, `matchImportToLibrary` :4
  - `ImportStatement` (interface) — one parsed import statement to match against a library :10
- `extract.ts`
  - `Extractor` (interface) — selects and groups a project's dependency-manifest files. `createContexts` :5
  - `Parser` (interface) — turns a manifest file into a dependency tree. `parseDependencyTree` :12
  - `ParseDependencyTree` (type) — signature for a manifest-to-DepinderProject parse function :15
  - `DependencyFileContext` (interface) — one project's root, manifest and lock file paths for parsing :24
  - `DepinderProject` (interface) — parsed project: name, version, dependency tree, vuln-exactness flag :31
  - `DepinderDependency` (interface) — one resolved dependency node with version, requesters, vulns :55
- `plugin-loader.ts`
  - `defaultPlugins` (const: Plugin[]) — the built-in plugin registry loaded at startup :10
- `plugin.ts`
  - `Plugin` (interface) — bundles a technology's extractor, parser, registrar, checker, codeFinder :6
  - `ecosystemOf` (function) — resolves a plugin's cache namespace, defaulting to its name :24
- `registrar.ts`
  - `Registrar` (interface) — fetches library metadata from a package manager registry. `retrieve` :6
  - `RegistryRetriever` (type) — signature for a registry lookup function :10
  - `LibraryInfo` (interface) — aggregated metadata for a library across all its versions :20
  - `AbstractRegistrar` (class → Registrar) — chains registrars, falling through to `next` on failure. `retrieve`, `retrieveFromRegistry` :37
  - `RegistryType` (type) — supported libraries.io registry keys :59
  - `LibrariesIORegistrar` (class → AbstractRegistrar) — library metadata from the libraries.io API. `retrieveFromRegistry` :61
  - +1 internal helpers not listed
- `vulnerability-checker.ts`
  - `VulnerabilityChecker` (interface) — per-plugin vulnerability lookup hooks. `getPURL`, `check` :1
  - `Vulnerability` (interface) — one vulnerability record: severity, score, ranges, patched version :10

## Notes
- `Extractor.createContexts` and `Parser.parseDependencyTree` are the two calls every plugin's
  pipeline stage hinges on; `Plugin.parser`, `checker` and `codeFinder` are optional.
- `DepinderProject.exactVersionVulnerabilities` gates whether `analyse` trusts a dependency's
  `vulnerabilities` as final (SBOM scans) or fills it from `LibraryInfo` via semver range.
