<!-- ai-index v1 · depth: files=signatures, subdirs=names -->
# src/plugins/ruby

**Role:** Ruby/Bundler dependency source — parses a Gemfile.lock into a
DepinderProject and enriches libraries from RubyGems.org.

## Files
- `index.ts`
  - `retrieveFormRubyGems` (function) — fetches gem metadata and version
    history from rubygems.org, cached in-memory :86
  - `ruby` (const: Plugin) — plugin descriptor: extractor, parser, registrar,
    vulnerability checker :133
  - +7 internal helpers not listed

## Notes
- Only `Gemfile.lock` is actually parsed; `Gemfile`/`*.gemspec` are listed as
  extractor files but not used to derive requestedBy for direct deps (see TODO
  at line 60).
