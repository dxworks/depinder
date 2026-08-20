<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/info/php

**Role:** Parses PHP Composer manifest and lockfile JSON into typed structures for dependency enrichment.

## Files
- `parser.ts`
  - `ComposerSupport` (interface) — support-channel URLs from a composer.json's `support` block :4
  - `Composer` (interface) — shape of a parsed composer.json manifest :16
  - `ComposerLock` (interface) — shape of a parsed composer.lock file :36
  - `ComposerPackageLocation` (interface) — a package's `source`/`dist` VCS location :43
  - `ComposerPackage` (interface → Composer) — a locked package enriched with Packagist stats and vulnerabilities :49
  - `parseComposerFile` (function) — reads and parses a composer.json file into a `Composer` :74
  - `parseComposerLockFile` (function) — reads and parses a composer.lock file into a `ComposerLock` :78
  - `getAllDependenciesFromLock` (function) — enriches every locked package with Packagist data in parallel :99
  - `getAllDependenciesFromComposerJson` (function) — resolves a list of package names to full Packagist details :104
  - +1 internal helpers not listed
