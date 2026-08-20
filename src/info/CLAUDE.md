<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/info

**Role:** Groups per-ecosystem manifest/lockfile parsers that turn package metadata into typed structures for dependency enrichment.

## Subdirs
- `php/` — parses PHP Composer manifest and lockfile JSON into typed structures for dependency enrichment. `ComposerSupport`, `Composer`, `ComposerLock`, `ComposerPackageLocation`, `ComposerPackage`, `parseComposerFile`, `parseComposerLockFile`, `getAllDependenciesFromLock`, `getAllDependenciesFromComposerJson`
