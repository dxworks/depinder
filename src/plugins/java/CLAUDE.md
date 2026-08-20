<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/java

**Role:** Java/Maven dependency source — parses a `deptree.txt` Maven dependency tree into a DepinderProject and enriches libraries from Maven Central.

## Files
- `index.ts`
  - `MavenCentralRegistrar` (class → AbstractRegistrar) — library metadata from search.maven.org, falls back to fetching/parsing the POM. `retrieveFromRegistry`, `getPom` :99
  - `java` (const: Plugin) — plugin descriptor: extractor (pom.xml/build.gradle globs), parser, registrar, vulnerability checker :159
  - +6 internal helpers not listed
- `google.registrar.ts`
  - no exported symbols — entire file is commented-out draft code for a `GoogleMavenRegistrar` scraping maven.google.com

## Subdirs
- `parsers/` — parses `mvn dependency:tree` text into a DepinderProject dependency graph. `parseMavenDependencyTree`

## Notes
- Requires a `deptree.txt` produced by `mvn dependency:tree`; without one this plugin parses zero modules.
- Gradle context type is wired in the extractor but `parseLockFile` throws `Unsupported context type: gradle` — Gradle is not actually supported yet.
- `google.registrar.ts` is dead code (fully commented out, not imported by `index.ts`).
