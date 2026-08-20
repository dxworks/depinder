<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/php

**Role:** PHP/Composer dependency source — parses composer.json/composer.lock into a
DepinderProject and enriches libraries from Packagist.

## Files
- `index.ts`
  - `parseComposerFile` (function) — reads composer.json into a `Composer` object :29
  - `parseComposerLockFile` (function) — reads composer.lock into a `ComposerLock` object :33
  - `PackagistRegistrar` (class → AbstractRegistrar) — library metadata from
    packagist.org. `retrieveFromRegistry` :104
  - `php` (const: Plugin) — plugin descriptor: extractor globs, parser, registrar,
    vulnerability checker :141
  - +5 internal helpers not listed
- `php-interfaces.ts`
  - `IPackagistPackageSource` (interface) — vcs/dist source block of a package version :3
  - `IPackagistPackageVersionDetails` (interface) — shape of one version entry from
    Packagist's metadata/details APIs :10
  - `IPackagistMetadataResponse` (interface) — shape of `p/{vendor}/{pkg}.json` response :53
  - `VendorPackageInput` (type) — accepted forms of a package identifier :61
  - `getPackageMetadata` (function) — fetches versioned metadata from
    repo.packagist.org, honoring If-Modified-Since :71
  - `IPackagistPackageDetails` (interface) — shape of a package details response :90
  - `IPackagistPackageDetailResponse` (interface) — wrapper for `getPackageDetails` :118
  - `getPackageDetails` (function) — fetches full package details from
    packagist.org/packages/{vp}.json :125
  - `IPackagistStatistics` (interface) — shape of Packagist's global statistics :151
  - `getPackagistStats` (function) — fetches Packagist's global download/package stats :162
  - +1 internal helper not listed

## Notes
- Extractor only creates a context per `composer.lock`; a bare `composer.json` with no lock
  yields zero dependencies (see the `dependencies == null` branch in `parseLockFile`).
